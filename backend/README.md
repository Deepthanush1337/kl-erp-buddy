# KL ERP Buddy — backend

FastAPI proxy that logs into [newerp.kluniversity.in](https://newerp.kluniversity.in)
with a student's own credentials, solves the login captcha with an ONNX CRNN model
(`model/crnn.onnx` + `model/crnn.json`), scrapes timetable / attendance / grades /
exam-seating pages and returns clean JSON.

## Endpoints

| Route                    | Purpose                                   |
| ------------------------ | ----------------------------------------- |
| `GET /`                  | health check (`{"status": "healthy"}`)    |
| `POST /login`            | ERP login, returns session cookies        |
| `POST /fetch-timetable`  | weekly timetable                          |
| `POST /fetch-attendance` | per-course attendance                     |
| `POST /fetch-register-detail` | day-wise attendance register         |
| `POST /fetch-cgpa`       | CGPA / semester summary                   |
| `POST /fetch-marks-detail`  | per-course marks breakdown             |
| `POST /fetch-seating-plan`  | exam seating                           |

All POST routes take form fields (ERP credentials and/or session cookies
`PHPSESSID`, `kl_erp_device_id`, `SERVERID`, `_csrf`) — see `main.py` and
`frontend/app.js` for the exact payloads.

## Run locally

Requires Python 3.12+ (developed on 3.14, deployed on 3.12).

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate          # Windows Git Bash; on Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000
```

The API is then at http://127.0.0.1:8000 (`GET /` should return
`{"status":"healthy","captcha_model":true}`). Serve `frontend/` separately
(e.g. `python -m http.server 5500`) and it will talk to this backend.

## Run with Docker

```bash
cd backend
docker build -t kl-erp-buddy-api .
docker run --rm -p 8000:8000 kl-erp-buddy-api
```

The image is `python:3.12-slim`, runs uvicorn as a non-root user, and ships a
`HEALTHCHECK` that hits `GET /`. `model/` is copied into the image by
`COPY . .` (the captcha model is loaded from disk at startup), while `.venv/`,
`__pycache__/` and logs are excluded via `.dockerignore`.

## Deploy to Render (free tier)

`render.yaml` is a Render Blueprint — the service definition is already in place:

1. Push the repo to GitHub.
2. Render → **New → Web Service** → pick the repo, set **Root Directory = `backend`**,
   **Runtime = Docker** (Render picks up the `Dockerfile`; or use
   **New → Blueprint** and it will read `render.yaml` directly).
3. Render builds the image, exposes port 8000 (from `EXPOSE`) and uses
   `GET /` as the health check (`healthCheckPath: /`).
4. Note the assigned URL (e.g. `https://kl-erp-buddy-api.onrender.com`) and set it
   as `API_BASE` in `frontend/config.js`.

Free-tier notes: the service sleeps after ~15 min idle; the first request after a
sleep takes ~30–60 s (cold start). No environment variables are required — the app
has no secrets; students supply their own ERP credentials per request.

## Notes

- `requirements.txt` is a pinned freeze of the direct deps (fastapi, uvicorn,
  httpx, onnxruntime, numpy, pillow, beautifulsoup4, python-multipart) plus their
  hard runtime deps. `httpx[http2]` / `h2` is required — the app talks to the ERP
  over HTTP/2.
- The captcha model files (`model/crnn.onnx`, `model/crnn.json`) must be present
  next to `main.py`; without them logins cannot be solved.
- CORS is open (`*`) in `main.py` so the static frontend on any origin can call it.
