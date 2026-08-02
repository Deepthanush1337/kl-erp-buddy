# KL ERP Buddy

A personal dashboard for KL University students — timetable, attendance (with bunk
calculator), grades and exam seating, pulled straight from
[newerp.kluniversity.in](https://newerp.kluniversity.in) with your own ERP login.

## How the "no captcha" thing actually works

There is no captcha bypass. The ERP login form validates the captcha server-side on
every login. What the senior tools (e.g. timetablekl.vercel.app) do — and what this
project does — is **solve** the captcha automatically: the Yii captcha is a simple
pink-on-white letter image, and a small CRNN (CTC) neural net (`backend/model/crnn.onnx`)
reads it with high accuracy. Login flow per request:

1. `GET /index.php?r=site/login` → grab CSRF token + session cookie
2. dummy POST → captcha image URL for this session
3. `GET` the captcha image → ONNX model decodes the letters
4. real POST with `LoginForm[username/password/captcha]` → authenticated session
5. scrape the ERP pages and return clean JSON

If a solve comes out wrong the login simply retries with a fresh captcha (up to 3×).
Sessions are then reused via cookies (`PHPSESSID`, `kl_erp_device_id`, `SERVERID`,
`_csrf`) until they expire, at which point the backend re-logs-in automatically.

Captcha model + scraping protocol adapted from the public senior project
[render_testb_docker](https://github.com/sivadhanushreddykotturu/render_testb_docker).

## Layout

```
backend/            FastAPI proxy (the part that talks to the ERP)
  main.py           all endpoints: /login, /fetch-timetable, /fetch-attendance,
                    /fetch-register-detail, /fetch-cgpa, /fetch-marks-detail,
                    /fetch-seating-plan
  model/crnn.onnx   captcha solver (+ crnn.json metadata)
  Dockerfile        for Render deployment
frontend/           static PWA-style app (no build step)
  config.js         ← the ONLY place the backend URL is set
```

## Run locally

```bash
# backend (http://localhost:8000)
cd backend
python -m venv .venv && .venv/Scripts/activate     # or source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000

# frontend (http://localhost:5500)
cd frontend
python -m http.server 5500
```

Open http://localhost:5500 and sign in with your ERP credentials. Credentials and
session cookies are stored only in your browser's localStorage.

## Deploy (free tier)

**Backend → Render** (needs Docker because of onnxruntime + the 13 MB model):

1. Push this repo to GitHub.
2. Render → New → Web Service → pick the repo, set **Root Directory = `backend`**,
   Runtime = Docker. `backend/render.yaml` and the `Dockerfile` are already in place.
3. Note the URL, e.g. `https://kl-erp-buddy-api.onrender.com`.

**Frontend → Vercel:**

1. Edit `frontend/config.js` → set `API_BASE` to your Render URL.
2. Vercel → New Project → import repo, set **Root Directory = `frontend`** (no build
   command, no output dir override needed).
3. Done — open the Vercel URL on your phone and "Add to Home Screen".

Render free tier sleeps after 15 min idle; the first request after a sleep takes
~30–60 s (cold start). The frontend will just show a loading spinner meanwhile.

## Notes

- **Turnstile:** the login form has a Cloudflare Turnstile checkbox, verified server-side
  on `POST /login`. Both sides ship with Cloudflare's official always-pass **test**
  keypair (site key in `frontend/config.js`, secret default in `backend/main.py`) so it
  works out of the box — the widget shows a "for testing only" watermark until you swap
  in a real keypair from the Cloudflare dashboard (set `TURNSTILE_SECRET` as a Render
  env var and `TURNSTILE_SITE_KEY` in `frontend/config.js`).
- Academic-year → ERP code mapping is **not** a clean formula: 2024-25→16,
  2025-26→19, 2026-27→29 (see `academicYearCode()` in `frontend/app.js`). Extend the
  map when a new academic year starts.
- If attendance/grades show empty states for a fresher account, that's the ERP having
  no rows yet — not a bug. Timetable works from day one.
- Timetable slots are the ERP's 1–24 period numbers per day; the frontend assumes
  slot 1 starts 08:00 for the "current slot" highlight.
