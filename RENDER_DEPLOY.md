# Deploying to Render

This app already runs as a plain Node/Express server (`server.js`) — Render
runs that directly, with no per-request timeout, unlike Netlify's serverless
functions. Two ways to set it up:

## Option A — Blueprint (fastest, uses render.yaml)

1. Push this repo to GitHub if it isn't already there.
2. In the Render dashboard: **New +** → **Blueprint**.
3. Connect the repo — Render reads `render.yaml` at the repo root and
   pre-fills the service (name, build/start commands, free plan, health
   check path).
4. It'll prompt you for the secrets marked `sync: false` in `render.yaml`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `GEMINI_API_KEY`
   - `ADMIN_EMAILS` (optional — leave blank if you don't need it yet)
5. Click **Apply**. `JWT_SECRET` is generated for you automatically.

## Option B — Manual web service (no render.yaml needed)

1. Render dashboard → **New +** → **Web Service**.
2. Connect your GitHub repo.
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
4. Under **Environment**, add each variable from `.env.example` — see
   below for where to get each value. Skip `PORT` (Render sets it itself).
5. Click **Create Web Service**.

## Where to get each value

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → your project → Project Settings → API → "Project URL" |
| `SUPABASE_SERVICE_KEY` | Same page → "service_role" key (**not** the anon/public key — the server needs it to bypass RLS for its own permission checks) |
| `JWT_SECRET` | Any long random string. Locally: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey — free tier, no card required |
| `GEMINI_MODEL` | Defaults to `gemini-flash-latest` if unset — fine to leave as-is |
| `ADMIN_EMAILS` | Comma-separated emails that get admin role on first login, e.g. `you@example.com` |

`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` are optional — only needed if you
want Claude instead of Gemini for the study helper. Gemini is used
automatically whenever `GEMINI_API_KEY` is set, even if an Anthropic key
is also present.

## Before your first deploy

Run every pending migration in `supabase/schema.sql` (and the earlier
`team_join_codes` migration, if you haven't already) against your Supabase
project — the app assumes those tables/columns exist and will error on
routes that touch them otherwise.

## After it's live

- Render gives you a URL like `https://reasoning-hub.onrender.com` —
  that's your whole app (frontend + API), since `server.js` serves
  `public/` itself. No separate frontend deploy needed.
- **Free-tier behavior**: the service spins down after 15 minutes with no
  traffic. The next request after that wakes it back up, which takes
  30–60 seconds. Everything works fine once it's awake — this only
  affects the very first request after a quiet period.
- Every `git push` to the connected branch triggers a new deploy
  automatically.

## Netlify stays untouched

`netlify.toml` and `netlify/functions/api.js` are unrelated to this setup
and don't need to be removed — they simply won't be used unless you point
a Netlify site at this repo too. You can run both simultaneously if you
want to compare, or delete the Netlify site once you're happy on Render.
