# Security audit — BookHub / Litheca

Date: 2026-07-22  
Scope: static review of `E:\GitHub\bookhub-api` and `E:\GitHub\bookhub`. No production requests, no user-data access, and no exploit attempts were performed.

## Executive summary

The strongest confirmed privacy issue is in the PDF-chat API: uploaded document content is addressed by a shared content hash, without an ownership check. The Firestore rules correctly protect a user's library and restrict unapproved comments, but public reaction documents expose Firebase UIDs and preference relationships. The public API also needs abuse/cost controls.

## Remediation log

Fixes are worked one finding at a time, in the priority order at the bottom
of this file. Each entry records what shipped and how it was verified.

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
  signup flow — an owner decision, and App Check is already a prerequisite for
  the games counter's Phase 2. Commit: bookhub `de5a8da`.

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

### H-04 — Public summary requests can trigger GitHub publishing (confirmed when publishing is enabled)

**Affected:** `bookhub-api/tools/summary.py`, `github_publisher.py`  
**Class:** Unauthenticated side-effect / content and quota abuse  
**Impact:** An anonymous caller can cause background GitHub writes and additional AI/external calls when `GITHUB_PUBLISH_ENABLED` is true.

Successful public English `/summary` requests enqueue publishing of a book, author, and characters. This can create repository noise, consume GitHub/API quotas, or publish undesired generated content.

**Required fix direction:** separate publishing from public read/generation requests. Queue only allow-listed or moderator-approved records, require an internal authenticated job trigger, and apply strict per-origin quotas.

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

## Evidence and scope notes

This report intentionally contains no secrets, no production data, no exploit payloads, and no instructions to access another user's account. Findings marked “confirmed” are based on static source review. Findings marked “unknown live state” require checking Firebase Console or deployed environment settings.
