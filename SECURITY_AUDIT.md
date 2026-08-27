# Security audit — BookHub / Litheca

Date: 2026-07-22  
Scope: static review of `E:\GitHub\bookhub-api` and `E:\GitHub\bookhub`. No production requests, no user-data access, and no exploit attempts were performed.

## Executive summary

The strongest confirmed privacy issue is in the PDF-chat API: uploaded document content is addressed by a shared content hash, without an ownership check. The Firestore rules correctly protect a user's library and restrict unapproved comments, but public reaction documents expose Firebase UIDs and preference relationships. The public API also needs abuse/cost controls.

## Remediation log

Fixes are worked one finding at a time, in the priority order at the bottom
of this file. Each entry records what shipped and how it was verified.

- **2026-08-27 — H-05 (teaching endpoint accepted non-existent books) —
  REMEDIATED.** `/akinator/submit` checked only that `body.book` matched a
  regex, never that it was a book the game ships, so any well-formed key was
  stored and later written into `overrides.json` by the drain. Fixed at both
  ends: `submit()` now answers `unknown_book` (failing open during an artifact
  outage), `drain()` skips unshipped keys entirely (failing closed, free there
  because it already refuses to run without artifacts) and reports them as
  `unknown` in its result. Verified against the live deploy: a fake but
  well-formed key that previously stored counts now answers `unknown_book`,
  while a real key still passes and dies later at the `question_hash` guard.
  `overrides.json` was clean at fix time (5 books, 41 cells, 0 orphans), so
  nothing needed pruning. Commit `5b25964`.

- **2026-08-27 — H-06 (single-IP training-data poisoning) — INTERIM
  MITIGATION, NOT REMEDIATED; known-weak by design.** One submission carries
  ~47 cells of one book, so against the 40/IP/day cap a single IP could drive
  every cell of a chosen book to 0.90 — equal to `PRESENCE_CONFIDENCE`, the
  value reserved for verified facts — in one day, for free. A per-client,
  per-book daily cap (`MAX_PER_BOOK_DAILY`, 2) now makes that cost 20 distinct
  IPs in a day or one IP for 20 days, and is charged only for submissions
  about to be stored. **This does NOT solve H-06:** an attacker rotating IPs
  is unaffected, exactly as with H-04. Verified: a third submission of one
  book from one client is refused while the same client on another book, and
  another client on the same book, both proceed. Commit `0ac5292`.

- **2026-08-27 — hardening alongside H-05/H-06 (no finding of its own).**
  Three items found in the same audit. (a) `_artifacts()` and
  `_shipped_titles()` were cached for the life of the process with no TTL —
  after a question-list rebuild the server kept the stale `question_hash` and
  silently rejected *every* submission as `stale_client` until Render
  restarted; both now expire after an hour and serve stale rather than empty
  on a failed refresh, mirroring `tools/fandom.py`. (b) The admin, drain and
  sync secret gates compared with `!=`; now `secrets.compare_digest` over
  UTF-8 *bytes*, because `compare_digest` rejects non-ASCII `str` with a
  TypeError and headers decode as latin-1, so `X-Admin-Secret: café` would
  have turned a 403 into a 500. Verified live: wrong, empty, non-ASCII and
  prefix secrets all still answer 403, and an unset secret still closes the
  endpoint. (c) A comment in `tools/summary.py` claimed the true client was
  the *first* X-Forwarded-For hop while `_client_ip` has always taken the
  rightmost — corrected in place, since "fixing" the code to match would have
  made every rate limit in the project bypassable with one header. Commit
  `294c018`.

- **2026-08-27 — H-04 (unauthenticated GitHub publishing) — INTERIM
  MITIGATION, NOT REMEDIATED; known-weak by design.** A single non-rotating
  IP can no longer cheaply spam GitHub publish tasks from public `/summary`
  and `/summary/stream` requests: `tools/summary.py` gates every
  `background_tasks.add_task(github_publisher.publish_*, …)` call behind a
  new `_publish_quota_ok(request)`, built on the H-03 shared limiter
  (`quiz_core._rate_limit` + `_client_ip`, same rightmost-X-Forwarded-For
  identity). Default cap: `SUMMARY_PUBLISH_DAILY` (default 8) new-publish
  schedulings per IP per day — a conservative starting guess, not measured
  against real traffic; adjust via the Render env var if it turns out too
  tight or too loose. **This explicitly does NOT solve H-04.** An attacker
  rotating IPs (trivial, e.g. via any proxy pool) sails straight past a
  per-IP cap — the required fix direction below (queue + moderation/
  allow-list, or an authenticated internal trigger) is still fully open.
  Treat this as raising the cost of the *laziest* version of the attack
  only, nothing more.
  All four call sites are gated, not just the obvious two — `/summary`'s
  cache-hit static-page-refresh path and its new-book path, and the same
  two shapes duplicated inside `/summary/stream`'s SSE generator. The gate
  never affects the reader: it only decides whether publish tasks get
  scheduled, and `_publish_quota_ok` swallows `_rate_limit`'s
  `HTTPException` internally (logs and returns `False`) rather than letting
  a 429 reach the summary response. Verified with a real ASGI `TestClient`
  test (mocking only `github_publisher.publish_*`, `gemini_client.generate`,
  and `book_data.resolve_book` — the limiter itself was exercised for
  real): 4 new-book requests from one IP with the limit set to 3 all
  returned `200` with a genuine assembled summary, but only 3 scheduled a
  publish task; a different IP had its own independent budget. Commit:
  bookhub-api (this commit).

- **2026-08-27 — H-02 research: can Firestore rules allow `count()` while
  denying individual-document reads? — RULED OUT, no code/rules change.**
  Investigated whether a security rule could permit the `count()`
  aggregation on a collection like `books/{bookSlug}/likes` while denying
  `get`/`list` of the underlying documents — this would narrow H-02's UID
  exposure without needing Blaze/Cloud Functions. **Not possible, confirmed
  from official docs, not assumed.** Firestore's Aggregation-queries doc
  states aggregation queries are governed by exactly the same rule as the
  document-returning query they aggregate over: "The same rules apply to
  both normal queries that return documents and aggregation queries... 
  security rules control what conditions are allowed, not how data is
  returned." A read rule only distinguishes `get` (single document) from
  `list` (queries/collection reads) — `count()` is authorized under `list`,
  the identical rule that authorizes returning the full documents. The
  "Securely query data" doc's `request.query` reference — the only rule-side
  variable for inspecting an incoming query — exposes just `limit`,
  `offset`, and `orderBy`; no field marks a request as an aggregation, so a
  rule condition has no signal to write "allow only if this is a `count()`"
  even in principle. Consequence: any rule change that lets `count()`
  succeed on a reaction collection equally lets a client `list` it and read
  every UID directly — there is no rules-only middle ground. No emulator
  test was built, because no theoretical mechanism existed to test (per the
  session's own instructions: build a test only if a theoretical distinction
  is found first). **This path is ruled out for H-02 — do not re-propose
  it.** The real fix remains trusted server-side aggregation via Cloud
  Functions, still blocked on Blaze (see H-02 status below). No code or
  `firebase/firestore.rules` change was made. Sources:
  [Aggregation queries](https://firebase.google.com/docs/firestore/query-data/aggregation-queries),
  [Securely query data](https://firebase.google.com/docs/firestore/security/rules-query).

- **2026-08-18 — Mind-reader admin secret disclosed in a public CI log —
  ROTATED AND CLOSED; no unauthorised writes occurred.** The shared secret
  for the Worker→Render hop (`ADMIN_SECRET` / `AKINATOR_ADMIN_SECRET`) was
  added in the Cloudflare dashboard as a plain **Variable** instead of a
  **Secret**. Wrangler prints a config diff of local-vs-remote on every
  deploy and that diff includes variable *values*; a Secret contributes
  only its name. The value was therefore printed in full into
  `bookhub-api`'s GitHub Actions log — a **public** repository, whose
  Actions logs anyone can read.
  **Why this was severe rather than cosmetic:** the secret does not only
  guard the Access-protected admin page. `bookhub-api`'s
  `/akinator/admin/*` endpoints live on the public Render URL and are
  protected by that secret *alone* — Cloudflare Access is not in front of
  Render. Anyone holding the leaked value could exclude books, append
  rows to `matrix.bin`, and reword live questions while bypassing Access
  entirely. Confirmed live during triage with a deliberately malformed
  `work_key`, which returns `400` once the secret check has passed and
  `403` when it has not: the leaked value returned **400**, proving it was
  accepted. No write was performed by the probe.
  **Remediated:** a new value was generated and set on Render, and the
  Worker's Variable was deleted and re-added as a Secret. Re-probed after
  the redeploy — old value **403**, new value **400**. Exposure window was
  roughly 22 minutes.
  **Damage assessment:** none. `mokhhtar/bookhub`'s commit history contains
  no `mind reader admin:` commit, which is the only shape a write through
  these endpoints can take; every artifact change in the window is
  attributable.
  **Two hardening changes shipped with the rotation** (`bookhub-api`
  `6d50cca`). `preview_urls = false` is now stated explicitly in
  `worker/akinator-admin/wrangler.toml`: the same deploy log showed the
  setting flipping to `true`, and a preview URL
  (`<version>-<worker>.<subdomain>.workers.dev`) is exactly the
  unauthenticated route into the same script that `workers_dev = false`
  exists to prevent — its default has changed three times across Wrangler
  versions, so it must not be inferred. And the post-deploy guard no
  longer accepts "any status that is not 200", which a Worker erroring on
  every request would satisfy while guarding nothing; it now requires
  either a redirect to `*.cloudflareaccess.com` or a `403` from the
  Worker's own backstop, and fails on everything else including a redirect
  pointing somewhere that is not Access. Nine cases unit-tested.
  **The generalisable lesson**, recorded because the dropdown will be seen
  again: on Cloudflare Workers a Variable is not a weaker Secret, it is a
  different thing. It is printed in deploy logs, and it does **not**
  survive deploys — the same wrong choice produced both a disclosure and,
  on the following push, a silent outage.

- **2026-08-04 — Auth-review follow-up (email enumeration via UI copy) —
  CLOSED, mostly by configuration.** **Firebase's Email enumeration
  protection is enabled on this project** (owner-confirmed), which closes the
  reset-path leak at the platform layer: `sendPasswordResetEmail` no longer
  returns `auth/user-not-found`, and failed sign-in returns
  `auth/invalid-credential`, already mapped to the neutral "Wrong email or
  password." `"auth/user-not-found"` is consequently unreachable and is now
  annotated as such in both `ERRORS` maps so no future copy depends on it.
  The setting left the inverse defect, which was fixed: the UI still said
  "Reset link sent — check your inbox." although the call now resolves for
  addresses with no account and sends nothing — asserting a delivery that
  cannot be confirmed. Copy is now conditional ("If that email has an
  account…"), which is both the honest and the non-leaking wording. Also
  fixed while there: both reset paths rendered their success message in the
  red `.auth-error` style (measured `rgb(221,51,51)` in-browser), now green
  via `is-success` / `var(--success)` (`#2F6B4F`, verified to resolve).
  **Still open by design:** signup continues to return `EMAIL_EXISTS`, which
  no wording can fix; Google's mitigations are App Check or reCAPTCHA on the
  signup flow — an owner decision. (Correction to the first version of this
  entry: it claimed App Check was "already a prerequisite for the games
  counter's Phase 2". It is not — that counter shipped as a Cloudflare Worker
  on D1 and its client calls it with a plain `fetch`, so Firebase is not in
  that path. App Check would be a new cost, weighed on its own merits.)
  Commit: bookhub `de5a8da`.

- **2026-08-04 — Auth-review follow-up (sign-out error swallowing) —
  REMEDIATED.** Carried over from the auth-surface review, where it was
  logged as "(Low), cosmetic: `bhAuthUI.signOut` swallows a failed
  `signOut()`". Re-examination showed it was **a silent data-loss path, and
  the finding named the wrong layer**. `pushLibrary()` caught its own errors
  and only `console.warn`'d, so `flushLibrary()` could never reject and the
  `catch (e) {}` in `signOut` was dead code. Live path: a library change made
  inside the 2s debounce window fails to reach Firestore (offline), the
  failure stops at the console, `signOut(auth)` succeeds, and the `signedOut`
  branch of `onAuthStateChanged` then removes `bookhub_rl_v1` — losing the
  change from both stores, which is precisely what `flushLibrary`'s own
  comment says it exists to prevent. Fix: `pushLibrary` returns whether the
  write landed and keeps `pushPending` set when it did not (otherwise the
  next attempt returns early on `if (!pushPending)` and deletes the data
  anyway); `bhAuthUI.signOut` refuses to sign out on a failed flush and
  reports via `bhToast`; a failed `signOut(auth)` reports instead of closing
  the menu on a live session; `account.html`'s two buttons moved from
  `bhAuthOps.signOut()` (throws into an inline `onclick`, unhandled) to
  `bhAuthUI.signOut()`. Verified: clean `jekyll build`, all 6 inline script
  blocks pass `node --check`, the built page exposes `window.bhAuthUI.signOut`
  and `window.bhToast`, the error toast renders in-browser, and a
  state-machine test covers offline-blocks-sign-out / library-kept /
  pending-retained / retry-succeeds-and-wipes. Commit: bookhub `61e54af`.
  *Also closed since the review:* `/auth/action/` now carries `noindex: true`.

- **2026-07-24 — L-09 (AI-output XSS) — REMEDIATED.** Added a sanitizer at
  the final DOM boundary in both repos. Frontend: vendored DOMPurify 3.2.4
  (self-hosted, not CDN) in `bookhub/assets/js/purify.min.js`; a fail-closed
  `sanitizeHtml()` now wraps all four `innerHTML` sinks in `summary.html`
  (`parseSummaryMarkdown` ×3 including the raw `<h2>` pass-through, and the
  chat `formatMarkdown`), restricted to a closed formatting tag set with zero
  attributes. Backend: `bookhub-api/github_publisher.py` sanitizes the
  summary HTML with a stdlib `html.parser` allow-list before it is written
  into the published `_books/*.md`, closing the persistent (baked-into-static-
  page) variant. Verified: 6 adversarial payloads in a real browser (no
  execution, no surviving dangerous nodes) + 12 payloads against the Python
  sanitizer; legitimate formatting preserved; fail-closed paths fall back to
  text escaping. Commits: bookhub `e557995`, bookhub-api `4953602`.

- **2026-07-24 — H-03 (part 1 of 3: `/summary/chat`) — REMEDIATED.** This
  route was an unauthenticated Gemini call with no rate limit and unbounded
  `summary`/`history` bodies. Added Pydantic caps to `ChatRequest`
  (`bookhub-api/tools/summary.py`): title/author ≤300, summary ≤30000 (~6x
  the largest real summary), question ≤2000, history ≤20 turns, plus a
  per-message 4000-char truncation in the route. Added a per-real-client-IP
  daily limit (`SUMMARY_CHAT_DAILY`, default 60) via a new `_client_ip()`
  that reads the first X-Forwarded-For hop — correct behind Render's proxy,
  where `request.client.host` is the shared proxy address. Verified with a
  full ASGI test: oversized bodies → 422 before any Gemini call, 60 allowed
  then 429 per IP, and separate IPs keep independent budgets. **Still open
  (parts 2–3, next up):** the shared limiter fails *open* when Redis is
  unavailable, and the pdf/book-quiz routes still trust a caller-supplied
  `client_id`. Commit: bookhub-api `509369f`.

- **2026-07-24 — H-03 (parts 2–3: fail-open + spoofable client_id) —
  REMEDIATED.** The shared limiter (`bookhub-api/tools/quiz_core.py`
  `_rate_limit`) no longer fails fully open when Redis is down: it degrades to
  a process-local per-instance counter (single Render instance → still a real
  global cap; resets daily, size-bounded) — a graceful degrade, not a hard
  fail-closed, so the feature keeps working during a cache outage. All
  rate-limited routes now key on a server-derived, spoof-resistant client IP
  via a new shared `_client_ip()` instead of a body `client_id` a caller can
  rotate to mint fresh quota: `/quiz/book`, PDF-chat `/ingest` `/chat` `/quiz`
  (each now takes the Request), and `/summary/chat`. `_client_ip()` uses the
  RIGHTMOST X-Forwarded-For hop — the one Render's single proxy appends from
  the real connection — which also corrects part 1's earlier leftmost
  (spoofable) choice. Verified: rightmost-hop selection; the degrade counter
  enforces the cap with Redis down and keeps per-client budgets; a rotating
  client_id from one IP still hits the cap. Commit: bookhub-api `b981191`.

- **2026-07-24 — H-02 (UID/preference exposure) — DEFERRED (accepted risk).**
  The proper fix needs trusted server-side aggregation (Cloud Functions →
  Firebase Blaze plan), which is on the deferred launch checklist. Public
  counts use Firestore COUNT aggregation queries governed by the same read
  rules, so owner-only raw docs would break every count; client-maintained
  counters were declined (they trade privacy for count-integrity). Accepted as
  a moderate pre-launch risk (opaque UIDs + reading preferences); proper fix
  scheduled for Blaze enablement at launch. No code change. See the H-02
  section for the full rationale.

- **2026-07-24 — C-01 (PDF-chat cross-user access) — REMEDIATED (scoped).**
  Root-cause review narrowed the real exposure: doc_id is a SHA-256 of the PDF
  text and never appears in any URL or shareable surface (verified in
  pdf-chat.html — computed client-side, kept only in POST bodies and
  localStorage), so holding a doc_id implies holding the file; the
  contents/digest are thus not a cross-user disclosure. The one genuine leak
  was metadata: `/check` and `/ingest`'s dedup path returned the FIRST
  uploader's chosen title/filename (which can carry PII) to any later user who
  ingests the same file. Fix: `/pdfchat/check` now returns existence only (no
  meta); `/pdfchat/ingest`'s dedup path echoes the caller's OWN submitted
  metadata. The frontend renders from metadata it already holds (the open
  file, or its local-library entry) at all three `/check` call sites.
  Cross-user text dedup (a deliberate free-tier cost saver) is preserved; a
  full server-minted capability system was considered and judged
  disproportionate given the hash-id + no-URL-exposure facts — revisit only if
  doc_ids ever become URL-exposed. Verified: `/check` leaks no meta; a second
  uploader's dedup response carries their own filename, not the first
  uploader's. Commits: bookhub-api `c0e7140`, bookhub pdf-chat.html (this commit).

- **2026-07-24 — M-07 (operational info disclosure) — REMEDIATED.**
  Diagnostic surfaces are now gated behind an `EXPOSE_DIAGNOSTICS` env flag
  (default off) in `bookhub-api/main.py`: `/health` returns just
  `{"status":"ok"}` (still 200, so Render's health check + keep-warm ping keep
  working) instead of the model/publishing/config block; `/models` returns 404
  (it also made a live upstream call per hit); `/` returns a minimal identifier
  instead of the full route list; and FastAPI's `/docs`, `/redoc`,
  `/openapi.json` are disabled. Set `EXPOSE_DIAGNOSTICS=true` in the Render
  dashboard to re-enable all of them for debugging. Verified with TestClient
  both ways. Commit: bookhub-api `fe9cf72`.

- **2026-07-24 — M-06 (Firebase Storage rules) — SOURCE ADDED (needs Console
  deploy).** BookHub uses no Firebase Storage (the bucket
  `bookhub-42d9a.firebasestorage.app` is declared in the web config but no
  Storage SDK is loaded and no object is read/written; PDF text goes to the API
  → Redis). Added a deny-by-default `bookhub/firebase/storage.rules`
  (`allow read, write: if false` for `/{allPaths=**}`) as the version-
  controlled source of truth, mirroring the firestore.rules convention.
  **Action required:** paste it into Firebase Console → Storage → Rules and
  confirm the deployed rules match (the repo file is not auto-deployed).
  Commit: bookhub firebase/storage.rules (this commit).

- **2026-07-24 — M-06 (Storage rules) — DEPLOY CONFIRMED.** Owner pasted the
  deny-by-default rules into Firebase Console → Storage → Rules. Source and
  live now match; the bucket is closed.

- **2026-07-24 — M-05 (admin UID) — REMEDIATED.** `isAdmin()` in
  `bookhub/firebase/firestore.rules` now pins the owner's real account UID
  (`Vw6fkxgSBygc4RvMa0cgkW3KSqe2`) instead of the `REPLACE_WITH_ADMIN_UID`
  placeholder; comment notes a UID is non-secret and safe in source. **Action:**
  re-paste firestore.rules into Console so the live rules match source (if they
  already carried the real UID, this just removes the source drift).

- **2026-07-24 — L-08 (CORS wildcard) — REMEDIATED.** `bookhub-api/main.py` no
  longer falls back to `["*"]`. An unset/blank/bare-`*` `ALLOWED_ORIGINS` now
  resolves to the known production origins (litheca.com, www.litheca.com,
  mokhhtar.github.io, localhost:4000), never a wildcard; an explicit
  comma-separated value is still honored verbatim (prod already sets the full
  list). Verified across unset/blank/`*`/explicit inputs — `*` never survives.
  Commit: bookhub-api `b2e367f`.

## Verified: unverified Firebase accounts cannot create text content

For book comments, author comments, and reader recommendations, creation requires:

```text
request.auth != null
request.auth.token.email_verified == true
request.resource.data.uid == request.auth.uid
```

`request.auth.token.email_verified` is a Firebase-issued, signed ID-token claim evaluated by Firestore. It is **not** derived from browser state such as `window.bhUser.emailVerified`, localStorage, request JSON, or the displayed UI. Changing client-side values, calling Firestore directly, or bypassing the website UI cannot turn an unverified account into a verified one.

Therefore the `attacker` account described in this review cannot create a comment or reader recommendation until Firebase issues it an ID token with `email_verified: true`. A verified Google sign-in will legitimately satisfy this condition; that is an intended provider assertion, not a client-side bypass.

### Limits of this conclusion

This proves the checked-in rule logic. The live Firebase Console rule set and Firebase Authentication configuration were not queried. Verification must include a controlled live test using only the `attacker` account:

1. Before confirming its email, try a direct Firestore create for each text collection; it must return `permission-denied`.
2. Confirm the email, force-refresh the ID token, and repeat; the create must succeed only with `approved: false`.
3. Confirm that altering `uid`, `approved`, `createdAt`, any field name, or the document shape is rejected.
4. Compare the live Console rules byte-for-byte with `firebase/firestore.rules`.

No client-only bypass exists unless a separate privileged system can mint Firebase custom tokens or modify Firebase Authentication claims. No such system was found in the reviewed repositories.

## Findings requiring remediation

### C-01 — PDF-chat cross-user document access (confirmed) — REMEDIATED (scoped) 2026-07-24

**Affected:** `bookhub-api/tools/pdfchat.py` (`/pdfchat/check`, `/ingest`, `/chat`, `/quiz`)  
**Class:** Broken object-level authorization / IDOR  
**Impact:** Confidentiality of uploaded PDF text and metadata.

The document identifier is the SHA-256 hash of the extracted PDF text. Storage keys are based only on that value, and the `client_id` is only format-validated; it is not stored as an owner and is never compared at read time. Any party holding a valid document ID can check its metadata, chat with its contents, and request a quiz while the Redis object remains live (normally 48 hours).

**Required fix direction:** associate every uploaded document with an authenticated user or an unguessable, server-generated capability bound to the initiating browser/session; enforce it on every read and write. Do not use a shared content hash as the authorization boundary. Reconsider cross-user deduplication for private uploads.

### H-02 — Public Firestore reaction documents expose UIDs and preference graphs (confirmed) — DEFERRED (accepted risk) 2026-07-24

> **Status (2026-07-24): DEFERRED — accepted risk until launch.** The proper
> fix (trusted server-side aggregation) requires Cloud Functions, which need
> the Firebase **Blaze** plan — already deferred to the launch checklist. The
> public counts (ratings/likes/recs) are computed with Firestore COUNT
> aggregation queries, and those are governed by the same read rules, so
> making the raw UID-keyed docs owner-only would break every count. Interim
> alternatives were weighed and declined: client-maintained aggregate counters
> trade this privacy leak for a **count-integrity** hole (rules can't
> atomically bind a counter bump to its reaction write); dropping the
> snapshotted display name from like docs is marginal (uid→name is already
> derivable from public approved comments). Decision: accept pre-launch (opaque
> Firebase UIDs + reading preferences on a book site = moderate harm) and do
> the trusted-aggregation fix when Blaze is enabled at launch.
>
> **Update 2026-07-24:** Blaze is currently **blocked** — Google is rejecting
> the owner's payment card, so Cloud Functions may be unavailable for a while,
> not merely deferred. If Blaze stays blocked through launch, the only
> non-Blaze path is the client-maintained denormalized-counter design (raw docs
> owner-only + public aggregate docs), accepting its count-integrity weakness —
> revisit that tradeoff then. Until then the risk remains accepted.
>
> **Update 2026-08-27:** investigated and ruled out a narrower non-Blaze path
> — a rule permitting `count()` aggregation while denying individual-document
> reads on the same collection. Firestore has no mechanism for this: `count()`
> is authorized under the same `allow list` rule as a full document-returning
> query, and `request.query` (the only rule-side query inspector) carries no
> field that marks a request as an aggregation. See the dated Remediation log
> entry above for the full sourced argument. No non-Blaze mitigation exists
> for H-02 beyond what is already accepted; do not re-propose the count()-
> separation idea.

**Affected:** `bookhub/firebase/firestore.rules`  
**Class:** Privacy exposure / identifier enumeration  
**Impact:** A public reader can correlate a Firebase UID with ratings, book votes, likes, author likes, character likes, and comment likes.

The following collections allow public reads while their document IDs are user UIDs:

- `books/{bookSlug}/recs/{uid}`
- `books/{bookSlug}/ratings/{uid}`
- `books/{bookSlug}/comments/{commentId}/likes/{uid}`
- `authors/{authorSlug}/comments/{commentId}/likes/{uid}`
- `characters/{charSlug}/likes/{uid}`
- `authors/{authorSlug}/likes/{uid}`

Character and author-like documents additionally store `uid` and optional display data. The website uses counts, but an outside client can address Firestore directly under the granted rules.

**Required fix direction:** treat aggregate counts as a server-side concern. Use trusted aggregation (for example Cloud Functions/Cloud Run with Admin SDK) and restrict raw reaction documents to the owner and trusted server. Do not rely on the UI hiding UIDs.

### H-03 — Public API permits cost and availability abuse (confirmed) — REMEDIATED 2026-07-24

**Affected:** FastAPI routes invoking Gemini, external catalog sources, or GitHub publishing  
**Class:** Insufficient rate limiting / resource exhaustion  
**Impact:** Gemini quota and billing exhaustion, Render saturation, third-party API throttling.

Most expensive routes are public. PDF and book quiz limits use a caller-controlled `client_id`, which can be replaced at will; the counter also fails open when Redis is unavailable. `/summary/chat` accepts large unbounded `summary` and `history` fields and has no route-level quota.

**Required fix direction:** enforce limits at an infrastructure boundary using IP and/or authenticated identity, limit request body and history sizes in Pydantic, add concurrency/time budgets, and fail closed or degrade expensive operations when the quota store is unavailable.

### H-04 — Public summary requests can trigger GitHub publishing (confirmed when publishing is enabled) — INTERIM MITIGATION 2026-08-27 (per-IP cap; NOT the fix direction below)

**Affected:** `bookhub-api/tools/summary.py`, `github_publisher.py`  
**Class:** Unauthenticated side-effect / content and quota abuse  
**Impact:** An anonymous caller can cause background GitHub writes and additional AI/external calls when `GITHUB_PUBLISH_ENABLED` is true.

Successful public English `/summary` requests enqueue publishing of a book, author, and characters. This can create repository noise, consume GitHub/API quotas, or publish undesired generated content.

> **Status (2026-08-27): interim mitigation only, known-weak.** A per-real-
> client-IP daily cap (`SUMMARY_PUBLISH_DAILY`, default 8) now limits how
> many publish tasks a single non-rotating IP can schedule; see the
> Remediation log entry above for detail and verification. An attacker who
> rotates IPs is unaffected. The real fix (below) remains open.

**Required fix direction:** separate publishing from public read/generation requests. Queue only allow-listed or moderator-approved records, require an internal authenticated job trigger, and apply strict per-origin quotas.

### H-05 — Mind-reader teaching endpoint accepted counts for books that do not exist (confirmed) — REMEDIATED 2026-08-27

**Affected:** `bookhub-api/tools/akinator_learn.py`, `tools/akinator_drain.py`
**Class:** Missing authorization/validation on a write path / persistent data pollution
**Impact:** An anonymous caller could write arbitrary (regex-valid) book keys into `games/data/akinator/overrides.json`, a file every player downloads and nothing prunes.

`POST /akinator/submit` validated the *shape* of `body.book` and nothing else. `_book_states()` answers `{}` both for "no such book" and "artifacts unreachable", so the contradiction check skipped rather than rejected, the counts were stored, and the nightly drain then wrote `overrides.setdefault(work_key, …)` for a book that does not exist. Reachable with no account at 40 keys/IP/day; each key needed 8 submissions to cross `MIN_PLAYS` and could then carry ~47 cells.

**Remediated:** index-membership checks at both ends — `submit()` rejects an unshipped key with `unknown_book` (failing *open* during an artifact outage, since a silent end-of-game courtesy must not lose a whole outage's worth of real submissions), and `drain()` skips them entirely (failing *closed*, which is free there because it already refuses to run without artifacts). `akinator_suggest.py` has always done this check correctly; this is the same check in the two modules that were missing it. `overrides.json` was clean at the time of the fix (5 books, 41 cells, 0 orphan keys), so there was nothing to prune.

### H-06 — A single IP could decide any book's answers outright (confirmed) — INTERIM MITIGATION 2026-08-27 (per-book cap; economic, not an identity control)

**Affected:** `bookhub-api/tools/akinator_learn.py`, `tools/akinator_drain.py`
**Class:** Insufficient rate limiting / training-data poisoning
**Impact:** An anonymous caller could push any (book, question) cell to the maximum confidence the system allows, making the game confidently wrong about chosen books.

One submission carries a whole game — ~47 cells of one book at once — against a 40/IP/day cap and a `MIN_PLAYS` floor of 8. So a single IP, in a single day: 8 submissions put every cell of a book over the floor, and 40 drove every cell to `p = (40 + 10×0.5)/(40 + 10) = 0.90`, which equals `CLAMP_HIGH`/`PRESENCE_CONFIDENCE` — what the engine says about a *verified* fact, and precisely what `akinator_drain.py`'s docstring says play data must never reach. The existing contradiction guard does not cover the surgical case: answering honestly on 46 of 47 questions and lying on the 47th is a 2% contradiction rate against a 75% threshold.

> **Status (2026-08-27): interim mitigation, known-weak — same shape and same
> caveat as H-04.** A per-client, per-*book* daily cap (`MAX_PER_BOOK_DAILY`,
> 2) now makes those 40 plays cost 20 distinct IPs in a day, or one IP for 20
> days, instead of one IP for free. It is charged only for a submission about
> to be stored, so a stale tab or an incoherent game does not consume the
> quota real plays need. **An attacker rotating IPs is unaffected.**

Chosen over a distinct-client set, which would mean storing a per-book fingerprint of every player and would contradict the module's "no identity, no session" promise, and over Turnstile, which stays available as a later layer (already deployed in `bookhub-api/worker/games-stats/` for a lower-stakes counter).

**Required fix direction:** proof-of-humanity (Turnstile) or an authenticated identity on the teaching path, so that agreement is counted per *person* rather than per request; and/or a distinct-client threshold before any cell is written.

### M-05 — Firestore rule source has no active administrator UID — REMEDIATED 2026-07-24 (source set; confirm Console matches)

**Affected:** `bookhub/firebase/firestore.rules`  
**Class:** Configuration drift / availability risk  
**Impact:** If pasted as-is, no account can moderate or perform admin-only cleanup.

`isAdmin()` compares against the literal placeholder `REPLACE_WITH_ADMIN_UID`. The repository documentation says rules are manually pasted into Firebase Console, so the live rules may differ. This makes source control an unreliable representation of authorization.

**Required fix direction:** maintain a deployment-safe rule source with the correct non-secret UID, or use a reproducible deployment process; immediately compare the Console rules with source after every change. Never expose service-account credentials in client code.

### M-06 — Firebase Storage rules are absent from the reviewed repository — REMEDIATED 2026-07-24 (source added + Console deploy confirmed)

**Affected:** Firebase Storage bucket configuration  
**Class:** Missing configuration evidence  
**Impact:** Unknown until Console rules are reviewed.

The frontend declares a Storage bucket but no `storage.rules` file or Storage SDK use was found. PDF text is sent to the API rather than Storage, but the bucket must still be verified closed/restricted in Firebase Console.

**Required fix direction:** export/version-control Storage rules, deny by default, and verify the deployed rules.

### M-07 — Operational information disclosure (confirmed) — REMEDIATED 2026-07-24

**Affected:** `/health`, `/models`, API root  
**Class:** Excessive service metadata  
**Impact:** Helps reconnaissance; does not expose secrets directly in the reviewed code.

`/health` reports configuration and publishing state, `/models` enumerates available models, and `/` lists routes.

**Required fix direction:** restrict diagnostic endpoints in production or return only a minimal health status.

### L-08 — CORS default is unrestricted (confirmed) — REMEDIATED 2026-07-24

**Affected:** `bookhub-api/main.py`  
**Class:** Permissive cross-origin policy  
**Impact:** Any website can call public API endpoints and contribute to abuse; it is not a cookie-based data leak in the current design because credentials are disabled.

**Required fix direction:** require explicit production origins and reject the `*` fallback outside local development.

### L-09 — AI output and externally sourced content require an output-safety boundary — REMEDIATED 2026-07-24 (see Remediation log)

**Affected:** summary, Fandom, and PDF-chat rendering paths  
**Class:** Prompt injection / potential output XSS  
**Impact:** Depends on renderer behavior and future changes.

The backend places untrusted external or user-provided text into model prompts. The PDF-chat renderer escapes output before applying limited formatting, which is positive. Some summary output is inserted as HTML after a custom markdown conversion, so this behavior must remain strictly escaped/sanitized whenever prompts, renderers, or model output formats change.

**Required fix direction:** use a well-maintained HTML sanitizer at the final DOM boundary; never regard model output as trusted HTML; add adversarial regression tests.

## Controls that currently look sound in the reviewed Firestore source

- `users/{uid}` and `users/{uid}/library/*` require `request.auth.uid == uid`; no cross-user library read/write path was found.
- Comments and reader recommendations require an authenticated, email-verified token; creation fixes `approved` to `false`, fixes the UID to the caller, enforces field allow-lists, sizes, and server timestamp.
- Only `isAdmin()` can approve or edit text content.
- Unapproved comments/recommendations are not publicly readable; owners can read their own and admin can moderate them.
- Comment display paths reviewed escape user-controlled text before insertion. Continue testing this when formatting helpers change.

## Priority order

1. Disable or isolate PDF-chat sharing until ownership/capability enforcement exists.
2. Remove public raw reads of UID-keyed reaction documents; provide protected aggregate counts instead.
3. Put durable rate limiting and request-size/concurrency controls in front of all expensive API routes.
4. Remove anonymous GitHub publishing side effects from `/summary`.
5. Reconcile and deploy Firestore/Storage rules from a controlled source; validate the administrator UID.
6. Reduce diagnostic endpoint exposure and lock down production CORS.
7. Put a proof-of-humanity or authenticated identity on the mind-reader
   teaching path (H-06), so agreement is counted per person rather than per
   request. The per-book cap shipped 2026-08-27 raises the cost of the lazy
   version only; like H-04's per-IP cap, it does nothing against rotation.

## Evidence and scope notes

This report intentionally contains no secrets, no production data, no exploit payloads, and no instructions to access another user's account. Findings marked “confirmed” are based on static source review. Findings marked “unknown live state” require checking Firebase Console or deployed environment settings.
