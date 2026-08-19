# Reasoning Hub

One account, three trackers, files, and admin-to-user messaging.

- **`/matrix.html`** — 20-Day Matrix Accuracy Tracker
- **`/reasoning.html`** — The Reasoning Lab (integration + logic, 20 days)
- **`/prep30.html`** — 30-Day EE Year-2 Prep Track
- **`/files.html`** — My Files: upload documents (capped per user, admin-adjustable, default 10), optionally post publicly, or hand out a **share code / QR code** that unlocks one specific private file for whoever redeems it
- **`/redeem.html`** — where a scanned QR code (or a typed code) lands to unlock a shared private file
- **`/public-files.html`** — everyone's public postings, browsable by any signed-in user
- **`/reader.html`** — read a PDF/Word/text file without uploading it — only a tiny resume bookmark is saved
- **`/admin.html`** — hidden (no nav link for non-admins): promote/demote, pause, delete, set file limits, message, reset passwords, manage every uploaded file across all accounts, and join a user's live **screen share**
- A floating **Study Helper** widget follows you across every page (see `public/js/study-helper.js`), stays minimized/open the way you left it, and can start a **screen share** with an admin for support

Architecture: **GitHub repo → Netlify (static frontend + one serverless function) → Supabase (Postgres + Storage)**.

## Share codes / QR file access

Any file owner (or an admin) can generate a code from the "Share code / QR"
button on `/files.html`. That renders a QR code encoding a link to
`/redeem.html?code=...` plus the raw code for typing in by hand. Whoever
redeems it — by scanning the QR with their phone's camera, or typing the
code on `/redeem.html` or the box at the top of `/files.html` — gets
standing access to that one file (it shows up under "Shared with me"),
without the file becoming public. Every redemption notifies the file's
owner and every admin as a toast message, the same way admin→user messages
work. Codes can optionally have a max-use count, and can be revoked at any
time (revoking doesn't remove access already granted).

## Screen sharing

The Study Helper widget (bottom-right, on every page) has a share-screen
button. Starting a share notifies every admin; from `/admin.html` →
"Screen share" tab, an admin can join and watch live. This is peer-to-peer
WebRTC — the video never passes through the server, only the connection
setup (SDP/ICE) does, exchanged by both sides polling one row in the new
`screen_share_sessions` table every ~1.5s. No websocket server or extra
infrastructure is required, which is why it works on Netlify Functions.
This uses public STUN servers only (no TURN relay), so it may not connect
across some restrictive corporate/mobile networks — that's a reasonable
gap to accept for a study-support tool, but worth knowing before relying on
it for anything mission-critical.

## What was broken in the previous version, and what changed

If you're comparing against an earlier copy of this project, here's exactly
what was fixed:

1. **Uploads over ~6MB silently failed on Netlify.** The app allowed 25MB
   uploads, but Netlify Functions (AWS Lambda under the hood) cap a
   synchronous request body around 6MB. Fixed by lowering the limit to 5MB
   (`routes/files.js`, `public/files.html`).
2. **API routes could 404 on Netlify depending on how the path was passed
   through.** `netlify/functions/api.js` now passes `basePath:
   '/.netlify/functions/api'` to `serverless-http`, which strips that
   prefix before Express tries to match `/api/...` routes.
3. **Per-user file limits didn't exist at all**, despite the admin panel
   needing them. Added: a `max_files` column (`supabase/schema.sql`),
   enforcement on upload (`routes/files.js`), an admin endpoint to change
   it (`routes/admin.js`), and a control in `/admin.html`.
4. Removed a stray empty `.gitmodules` file that could cause confusing
   `git submodule` errors on some clients.
5. Pinned `NODE_VERSION = "20"` in `netlify.toml` so Netlify's build uses
   the same Node version this was built and tested against.
6. Removed an unused `@supabase/ssr` dependency from `package.json`.

## How it's wired together

Each tracker's own JavaScript calls `window.storage.get / set / delete /
list(key, shared)` — the same interface Anthropic's Claude artifacts use.
`public/js/storage-shim.js` replaces that object with one that calls the
real API (`/api/kv/...`) instead, so the trackers themselves never needed
to change.

The Express app (`app.js`) runs two ways from the same code:
- **Locally / Render / any Node host**: `server.js` wraps it and calls `app.listen()`.
- **Netlify**: `netlify/functions/api.js` wraps the same `app.js` with
  `serverless-http` — no `app.listen()`, Netlify invokes it per-request.
  `netlify.toml` redirects `/api/*` to that function.

```
reasoning-hub/
├── app.js                    the Express API (no listen — shared by both entrypoints)
├── server.js                  Node hosting entrypoint (Render/local)
├── netlify.toml                Netlify build + /api/* redirect config
├── netlify/functions/api.js    Netlify entrypoint, wraps app.js
├── db.js                       Supabase (Postgres + Storage) data layer
├── middleware/auth.js          JWT verification, admin gate, suspended-account gate
├── supabase/schema.sql         run once in Supabase → SQL Editor
├── routes/
│   ├── auth.js                 register / login / me
│   ├── kv.js                    the storage API behind window.storage
│   ├── admin.js                  user management, file limits, messaging
│   ├── files.js                   upload/list/download/delete documents, share codes
│   ├── screenshare.js              WebRTC signaling (polling, no websocket needed)
│   └── messages.js                admin→user message toasts
└── public/                      static frontend — served directly by Netlify's CDN
    ├── index.html, login.html, register.html
    ├── admin.html                 (not linked from nav for non-admins)
    ├── matrix.html / reasoning.html / prep30.html
    ├── files.html / public-files.html / reader.html / redeem.html
    ├── css/theme.css
    └── js/{storage-shim,nav,trend-chart,study-helper,screenshare}.js
```

## Step 1 — Supabase

1. Create a project at supabase.com.
2. **SQL Editor → New query** → paste the entire contents of
   `supabase/schema.sql` → Run. It's idempotent (safe to re-run) — **if
   you're updating an existing project to get share codes/QR access and
   screen sharing, re-run this file** to add the three new tables
   (`file_share_codes`, `file_share_access`, `screen_share_sessions`).
3. **Storage → New bucket** → name it exactly `documents` → keep it
   **Private** (the API hands out short-lived signed URLs for downloads,
   so it never needs to be public).
4. **Project Settings → API** → copy two values for Step 3:
   - **Project URL** → you'll set this as `SUPABASE_URL`
   - **service_role key** (not `anon`/`public`) → `SUPABASE_SERVICE_KEY`

   The service role key bypasses Row Level Security by design — the
   Express API is the only thing that ever talks to Supabase directly,
   the browser never receives this key. RLS stays enabled on every table
   as a safety net regardless.

## Step 2 — GitHub

```bash
cd reasoning-hub
git init
git add .
git commit -m "Reasoning Hub"
gh repo create reasoning-hub --private --source=. --push
# or: create the repo on github.com, then:
# git remote add origin <url> && git branch -M main && git push -u origin main
```

## Step 3 — Netlify

1. Netlify dashboard → **Add new site → Import an existing project** →
   pick your GitHub repo.
2. Build settings come from `netlify.toml` automatically — publish
   directory `public`, functions directory `netlify/functions`, build
   command `npm install`, Node 20. Confirm and deploy.
3. **Site configuration → Environment variables** → add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | from Step 1.4 |
   | `SUPABASE_SERVICE_KEY` | from Step 1.4 — **service_role**, not anon |
   | `JWT_SECRET` | any long random string — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `ADMIN_EMAILS` | your own email (comma-separated if more than one) |

4. **Deploys tab → Trigger deploy** so the function picks up the new
   environment variables (they don't apply retroactively to the first build).

## Step 4 — Become admin

Open your Netlify URL, register with the exact email you put in
`ADMIN_EMAILS`. You're an admin immediately — `/admin.html` works from
that point on (it's intentionally not linked in the nav for non-admins).

## Verifying it actually works

1. Register a second, non-admin test account.
2. Log in as admin, open `/admin.html`, confirm both accounts appear.
3. As the test account, upload a small file on `/files.html` — confirm it
   appears and can be opened.
4. As admin, send that test account a message — log in as them and reload
   any page, confirm the toast appears.
5. As admin, set that account's file limit to 1, then try uploading a
   second file as them — confirm it's rejected with a clear message.
6. As admin, delete the test account — confirm it disappears from
   `/admin.html` and its uploaded file is gone from Supabase Storage too.

If any of these fail, check the Netlify function logs (Netlify dashboard →
your site → Functions → `api`) — Supabase connection errors and permission
issues show up there with a clear message.

## What the admin panel can do

- **Promote / demote** a user between `user` and `admin`.
- **Pause an account** — they can still log in and see their existing
  data, but can't save new progress or upload/post files until unpaused.
- **Delete an account** — removes the user, every saved progress record
  across all three trackers, and every uploaded file (both the database
  row and the actual file in Supabase Storage).
- **Set a file limit per user** — defaults to 10; new uploads are rejected
  once a user hits their limit. Lowering someone's limit never deletes
  their existing files, it only blocks new uploads.
- **Reset a user's password** directly (there's no email-based reset flow).
- **Send a message** — pops up as a toast the next time that user loads
  any page.
- **Browse and delete any uploaded file**, across every account, from one
  table.

## Local development

```bash
npm install
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET, ADMIN_EMAILS
npm start
```

Open **http://localhost:4000**.

## Notes on hardening before wider use

This is a solid working base, not a security audit. Before putting it in
front of strangers, consider adding: rate limiting on `/api/auth/login`,
email verification, and a proper self-service password-reset flow
(currently admin-only).
