# CLAUDE.md

Persistent instructions for AI coding agents working in this repo. Read
this before making changes.

## What this is

The **BookHub** static site — Jekyll, hosted on **GitHub Pages**
(`mokhhtar.github.io/bookhub`), auto-deploying from `main` on every push
(no manual deploy step, no webhook to babysit — unlike the sibling API
repo, see below). Plain HTML/CSS/vanilla JS throughout: **no build step,
no bundler, no npm** for the frontend JS itself. Every page includes
`<script>` blocks directly; shared helpers like `esc()`/`$()` are
duplicated per page rather than imported from a module.

## The two-repo pair — read this first

- **This repo (`bookhub`)** — the site itself: Jekyll layouts, static
  page collections, and all client-side JS/Firebase logic.
- **`bookhub-api`** — the Python/FastAPI backend, sibling directory at
  `../bookhub-api`. `site.api_url` in `_config.yml` points to its live
  Render URL. That repo's `CLAUDE.md` covers backend conventions,
  storage layers, and infra gotchas.

**Most features touch both repos.** A new field in the backend's
`/summary` response is invisible here until you render it in **both**
`summary.html` (the dynamic, API-driven page) **and**
`_layouts/book.html` (the static, pre-published page) — these are two
independent templates with no shared partial between them; check both
whenever the API response shape changes.

## Site structure

```
_config.yml          # collections (books/authors/characters), site.api_url
_layouts/
  default.html          # base layout — loads header/footer/firebase.html
  book.html               # static published book page (from _books/*.md)
  author.html              # static author page
  character.html            # static character page
_includes/
  header.html               # nav, auth chip (Sign in / account menu)
  footer.html
  firebase.html              # Firebase SDK init — see below
summary.html          # the dynamic Summarizer tool (calls the API live)
account.html          # /account/ — sign-in/register + user data management
admin/comments.html   # /admin/comments/ — owner-only moderation queue
tools/*.html          # standalone tool pages (reading-list, pdf-chat, timer, …)
_books/, _authors/,
_characters/           # AUTO-PUBLISHED by the backend's github_publisher.py —
                        # don't hand-edit individual entries; the whole
                        # publishing pipeline lives in bookhub-api.
firebase/
  firestore.rules          # source of truth for Firestore security rules —
                            # NOT auto-deployed, see below
  DATA_MODEL.md              # Firestore schema + console setup checklist
```

## Firebase integration

Loaded via `_includes/firebase.html` as native ES modules straight from
the `gstatic.com` CDN — no npm install, no build step. It exposes a
small global surface for every other (non-module, classic-script) page
to use:
- `window.bhFirebase` — `{app, auth, db}`
- `window.bhFs` — Firestore functions (`doc`, `getDoc`, `setDoc`,
  `collection`, `collectionGroup`, `query`, `where`, `getCountFromServer`,
  etc.) — classic scripts call `window.bhFs.getDocs(...)`, not `import`.
- `window.bhUser` — current signed-in user or `null`
- `window.bhAuthOps` — raw auth operations (`signIn`, `signUp`,
  `signInGoogle`, `changePassword`, `reset`, `signOut`) shared between
  the header's login modal and the standalone `/account/` page.
- Listen for the `"bh-auth"` DOM event to react to sign-in/sign-out
  anywhere on the page.

**`firestore.rules` is the ONLY authorization layer** — there's no
backend intermediary for Firestore data (comments, likes, ratings,
synced library). Every collection's read/write rules must be airtight on
their own. **Critical: editing `firebase/firestore.rules` in this repo
does NOT deploy it.** You must manually re-paste the file's contents into
Firebase Console → Firestore Database → Rules → Publish after every
change. This has caused real bugs (a feature shipped in code but broken
live because the console still had the old rules) — always tell the user
explicitly when `firestore.rules` changed and needs re-pasting.

Similarly, **new Firestore collection-group queries need a manually
created index** (Console → Firestore → Indexes → Exemptions, or via the
error-message link Firestore prints in the browser console on first
query). Code changes alone never create these.

## localStorage key conventions

Don't invent new key names ad hoc — reuse or extend these:
- `bookhub_rl_v1` — My Library (reading list): array of
  `{id, title, author, status, rating, addedAt, cover_url, b}`.
  `status` ∈ `want|reading|done`. Same store is read/written by
  `tools/reading-list.html`, the summary page's shelf bar, and synced to
  Firestore (`users/{uid}/library/list`) when signed in via
  `window.bhLibraryChanged()`.
- `bookhub_client_id` — anonymous per-browser UUID for rate-limited
  backend endpoints (quiz generation, etc.) — not a Firebase concept.
- `bookhub_recent_v1` — recently-viewed books, written by the summary
  page, read by `/account/`.
- `bh_auth_hint` — display name shown instantly on page load before
  Firebase's async session restore completes (prevents a "flash of
  signed-out state" that looks like a lost session).

## Design conventions

- **No emoji in interactive UI elements** (buttons, nav chips, badges,
  labels) — use inline SVG matching the existing icon language (check
  nearby icons for `stroke-width`, `viewBox`, and size conventions before
  adding a new one; don't pull in an icon font/library).
- **Reuse existing card/chip CSS classes** (`.summary-card`,
  `.sidebar-badge`, `.char-item`, etc.) instead of inventing new ones for
  a similar-looking component — grep for the class first.
- **Mobile-first touch targets**: minimum ~42-44px for tappable elements;
  form inputs need `font-size: 16px` or iOS Safari auto-zooms on focus
  (this has bitten real features — check any new `<input>`).
- Match the site's existing card/grid patterns (`authors/index.html`,
  `categories/category.html`) for "grid of items" UI rather than
  designing a new layout from scratch.

## A JS bug pattern to avoid (bit us in production)

**Temporal dead zone (TDZ) crashes on direct-link entry.** Several pages
run entry-point logic (e.g. `?q=` / `?b=` query-param handling) that can
execute **synchronously during script parsing** when the page is loaded
via a direct link (as opposed to in-page navigation, where the same code
runs later after everything's initialized). Any `const`/`let` referenced
by that entry-point code **must be declared before it in source order**,
not just "somewhere in the file" — a mid-script `const TOOL_BASE_PATH =
...` caused `Cannot access 'TOOL_BASE_PATH' before initialization` for
every homepage-search visitor while working fine for every in-page
search, because only the homepage path hit the code before the
declaration ran. When adding a new top-level `const` a script's entry
point might touch, declare it at the very top of the `<script>` block.

## Testing before every push

`bundle exec jekyll build` locally, then check the actual generated
`_site/` output for the page you changed (not just "build succeeded" —
Liquid errors on unrelated pages can silently produce empty/broken HTML
for the page you care about). For anything touching Firebase, also
manually click through the flow in a browser — Firestore rule rejections
and missing indexes only surface at runtime, not at build time.

Ship **one commit + push per logical step**; GitHub Pages rebuilds
automatically within ~1-2 minutes of push — no separate deploy action
needed on this side.

## Sibling repo

Backend: `../bookhub-api` (FastAPI on Render). Its `CLAUDE.md` covers the
four storage layers (Render/Redis/Firebase/GitHub), cache versioning,
and backend-specific infra gotchas — read it too when a change spans
both repos.
