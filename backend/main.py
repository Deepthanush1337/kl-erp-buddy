"""
KL ERP Buddy — backend proxy for newerp.kluniversity.in

Logs into the KL University ERP on behalf of the student (their own account),
solving the Yii login captcha with a small CRNN (CTC) ONNX model, then scrapes
timetable / attendance / grades / seating-plan HTML and returns clean JSON.

Captcha model (model/crnn.onnx) and the overall scraping protocol are adapted
from the public senior project: github.com/sivadhanushreddykotturu/render_testb_docker
"""

import asyncio
import base64
import hashlib
import hmac
import io
import json
import logging
import os
import random
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime
from urllib.parse import unquote, urlparse

import httpx
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from html import unescape
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("kl-erp-buddy")

# ------------------ CAPTCHA SOLVER ------------------
try:
    with open("model/crnn.json", "r") as f:
        _captcha_meta = json.load(f)
    _captcha_alphabet = _captcha_meta["alphabet"]
    _captcha_img_w = _captcha_meta["img_w"]
    _captcha_img_h = _captcha_meta["img_h"]
    _captcha_session = ort.InferenceSession("model/crnn.onnx")
    logger.info("Captcha model loaded (%s)", _captcha_meta.get("model_kind"))
except Exception as e:
    logger.error("Failed to load captcha model: %s", e)
    _captcha_session = None


def solve_captcha(image_bytes: bytes) -> str:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    img = img.resize((_captcha_img_w, _captcha_img_h))
    alpha = np.array(img)[:, :, 3].astype(np.float32) / 255.0
    tensor = alpha[np.newaxis, np.newaxis, :, :]
    inputs = {_captcha_session.get_inputs()[0].name: tensor}
    logits = _captcha_session.run(None, inputs)[0][0]
    out, last = [], -1
    for t in range(logits.shape[0]):
        best = int(np.argmax(logits[t]))
        if best != last and best != 0:
            out.append(_captcha_alphabet[best - 1])
        last = best
    return "".join(out)


# ------------------ CONSTANTS ------------------
ERP_HOST = "newerp.kluniversity.in"
BASE_URL = f"https://{ERP_HOST}"

# Input whitelists (security: reject anything else with 422)
RE_USERNAME = re.compile(r"^[0-9]{6,12}$")
RE_ACADEMIC_YEAR = re.compile(r"^[0-9]{1,3}$")
RE_SEMESTER = re.compile(r"^[0-9]{1,3}$")
RE_SERVER_ID = re.compile(r"^erp[0-9]$")


def _validate(pattern: re.Pattern, value: str, field: str) -> None:
    if not pattern.fullmatch(value or ""):
        raise HTTPException(status_code=422, detail=f"Invalid {field}.")


def _is_erp_url(url: str) -> bool:
    """SSRF guard: only allow requests whose final host is exactly the ERP host."""
    try:
        return urlparse(url).hostname == ERP_HOST
    except Exception:
        return False


DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

limits_pool = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global limits_pool
    limits_pool = httpx.Limits(max_keepalive_connections=50, max_connections=200, keepalive_expiry=30.0)
    yield


app = FastAPI(title="KL ERP Buddy Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"success": False, "message": "Bad request.", "detail": str(exc.errors())})


@app.get("/")
def health():
    return {"status": "healthy", "captcha_model": _captcha_session is not None}


# ------------------ HTTP HELPERS ------------------
def is_login_failed(response: httpx.Response) -> bool:
    url_str = str(response.url)
    if "site%2Flogin" in url_str or "site/login" in url_str:
        return True
    if "LoginForm[username]" in response.text or "LoginForm[password]" in response.text:
        return True
    if "<h4" in response.text and "Login" in response.text:
        return True
    return False


def extract_csrf(html: str) -> str:
    m = re.search(r'name="csrf-token"\s+content="([^"]+)"', html)
    if m:
        return m.group(1)
    m = re.search(r'<input[^>]+name="_csrf"[^>]+value="([^"]+)"', html)
    if m:
        return m.group(1)
    m = re.search(r'<input[^>]+value="([^"]+)"[^>]+name="_csrf"', html)
    if m:
        return m.group(1)
    return ""


def collect_cookies(response: httpx.Response, base: dict) -> dict:
    merged = dict(base)
    for header_val in response.headers.get_list("set-cookie"):
        part = header_val.split(";")[0].strip()
        if "=" in part:
            k, v = part.split("=", 1)
            merged[k.strip()] = v.strip()
    return merged


async def _follow_redirects_collecting_cookies(
    client: httpx.AsyncClient, method: str, url: str, step_cookies: dict, timeout: int = 30, **kwargs
) -> tuple[httpx.Response, dict]:
    current_url = url
    current_cookies = dict(step_cookies)
    resp = None
    for _ in range(10):
        if method == "POST":
            resp = await client.post(current_url, cookies=current_cookies, follow_redirects=False, timeout=timeout, **kwargs)
        else:
            resp = await client.get(current_url, cookies=current_cookies, follow_redirects=False, timeout=timeout, **kwargs)
        current_cookies = collect_cookies(resp, current_cookies)
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("location", "")
            if not location:
                break
            if location.startswith("/"):
                parsed = urlparse(current_url)
                location = f"{parsed.scheme}://{parsed.netloc}{location}"
            elif not location.startswith("http"):
                location = BASE_URL + "/" + location
            current_url = location
            method = "GET"
            kwargs = {}
        else:
            return resp, current_cookies
    return resp, current_cookies


# ------------------ AUTO LOGIN (captcha-solving) ------------------
async def auto_login(client: httpx.AsyncClient, username: str, password: str, seed_cookies: dict) -> tuple[httpx.Response, dict]:
    login_url = f"{BASE_URL}/index.php?r=site%2Flogin"
    logger.info("[LOGIN] auto-login for user=%s", username)
    headers = dict(DEFAULT_HEADERS)

    # 1. cold handshake
    res, cookies = await _follow_redirects_collecting_cookies(client, "GET", login_url, {}, headers=headers)
    res.raise_for_status()
    csrf = extract_csrf(res.text)
    if not csrf:
        raise Exception("CSRF token not found on login page.")

    await asyncio.sleep(random.uniform(0.3, 0.7))

    # 2. dummy post so the server emits a captcha bound to this session
    dummy = {"_csrf": csrf, "LoginForm[username]": "", "LoginForm[password]": ""}
    headers.update({"Origin": BASE_URL, "Referer": login_url})
    res_post, cookies = await _follow_redirects_collecting_cookies(client, "POST", login_url, cookies, data=dummy, headers=headers)
    res_post.raise_for_status()

    captcha_match = re.search(r'src="([^"]*?r=site%2Fcaptcha[^"]*?)"', res_post.text)
    if not captcha_match:
        raise Exception("Captcha image URL not found.")

    # 3. fetch captcha image
    captcha_url = BASE_URL + captcha_match.group(1).replace("&amp;", "&")
    headers["Accept"] = "image/avif,image/webp,image/*,*/*;q=0.8"
    captcha_response, cookies = await _follow_redirects_collecting_cookies(client, "GET", captcha_url, cookies, headers=headers)
    captcha_response.raise_for_status()

    # 4. solve
    captcha_text = solve_captcha(captcha_response.content)
    logger.info("[LOGIN] captcha solved: %s", captcha_text)
    if not captcha_text:
        raise Exception("Captcha solver returned empty text.")

    # 5. real login
    payload = {
        "_csrf": csrf,
        "LoginForm[username]": username,
        "LoginForm[password]": password,
        "LoginForm[captcha]": captcha_text,
        "LoginForm[rememberMe]": "0",
        "LoginForm[qr_code]": "",
    }
    headers["Accept"] = DEFAULT_HEADERS["Accept"]
    await asyncio.sleep(random.uniform(0.2, 0.5))
    response, final_cookies = await _follow_redirects_collecting_cookies(client, "POST", login_url, cookies, data=payload, headers=headers)
    response.raise_for_status()

    for key in ("kl_erp_device_id", "SERVERID"):
        if key not in final_cookies and key in seed_cookies:
            final_cookies[key] = seed_cookies[key]
    return response, final_cookies


async def login_with_retries(client: httpx.AsyncClient, username: str, password: str, seed_cookies: dict, attempts: int = 3):
    response, cookies = None, dict(seed_cookies)
    for attempt in range(attempts):
        if attempt > 0:
            await asyncio.sleep(random.uniform(1.0, 2.0))
        try:
            response, cookies = await auto_login(client, username, password, seed_cookies=cookies)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                logger.warning("[LOGIN] ERP 429 rate-limited (attempt %d for %s)", attempt + 1, username)
                if attempt < attempts - 1:
                    await asyncio.sleep(random.uniform(4.0, 8.0))
                    continue
                raise HTTPException(status_code=503, detail="KL ERP is rate-limiting logins right now. Wait a minute and try again.")
            raise
        if not is_login_failed(response):
            return response, cookies
        logger.warning("[LOGIN] attempt %d rejected (bad captcha or creds), retrying", attempt + 1)
    raise HTTPException(status_code=401, detail="Invalid username or password.")


# ------------------ SESSION POOL + LOGIN DEDUP ------------------
# The ERP rate-limits site/login per IP (~2 rapid logins -> 429). All users of
# this backend share one egress IP, so we aggressively avoid duplicate logins:
# (a) pooled sessions reused for SESSION_TTL seconds, (b) concurrent logins for
# the same user share one in-flight task instead of firing N captcha runs.
SESSION_TTL = 20 * 60
_session_pool: dict[str, tuple[float, dict, str]] = {}   # username -> (expiry, cookies, csrf)
_inflight_logins: dict[str, asyncio.Task] = {}


async def _login_fresh(username: str, password: str, seed_cookies: dict):
    async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as c:
        return await login_with_retries(c, username, password, seed_cookies=seed_cookies)


async def erp_login(username: str, password: str, seed_cookies: dict | None = None, force: bool = False):
    """Deduplicated ERP login. Returns (response|None, cookies, csrf).
    response is None when a pooled session was reused."""
    if not force:
        ent = _session_pool.get(username)
        if ent and ent[0] > time.time():
            return None, dict(ent[1]), ent[2]
    task = _inflight_logins.get(username)
    if task is None:
        task = asyncio.create_task(_login_fresh(username, password, seed_cookies or {}))
        _inflight_logins[username] = task
        task.add_done_callback(lambda _t: _inflight_logins.pop(username, None))
    response, cookies = await task
    csrf = extract_csrf(response.text)
    _session_pool[username] = (time.time() + SESSION_TTL, dict(cookies), csrf)
    return response, cookies, csrf


def erp_session_drop(username: str) -> None:
    _session_pool.pop(username, None)


def build_cookie_jar(php_sess_id: str, csrf_cookie: str, device_id: str, server_id: str) -> dict:
    return {
        "_csrf": unquote(csrf_cookie) if csrf_cookie else "",
        "PHPSESSID": php_sess_id,
        "kl_erp_device_id": unquote(device_id) if device_id else "",
        "SERVERID": server_id,
    }


def session_payload(cookie_jar: dict, old_php_sess_id: str, fallback_server: str, fallback_csrf: str):
    updated = cookie_jar.get("PHPSESSID")
    final_csrf = cookie_jar.get("_csrf", fallback_csrf)
    return {
        "session_refreshed": updated != old_php_sess_id,
        "cookies": {
            "PHPSESSID": updated,
            "kl_erp_device_id": cookie_jar.get("kl_erp_device_id", ""),
            "SERVERID": cookie_jar.get("SERVERID", fallback_server),
            "_csrf_token": final_csrf,
            "_csrf": final_csrf,
        },
    }


def build_register_url(base_url: str, href: str) -> str | None:
    try:
        full_relative_path = href.split(base_url)[-1]
        register_url_segment = full_relative_path.split("?r=")[-1]
        r_param_end = register_url_segment.find("&")
        if r_param_end != -1:
            r_path = unquote(register_url_segment[:r_param_end])
            params_raw = register_url_segment[r_param_end:]
            url = f"{base_url}/index.php?r={r_path}{params_raw}"
        else:
            url = f"{base_url}/index.php?r={unquote(register_url_segment)}"
        return url if _is_erp_url(url) else None
    except Exception:
        return None


def strip_tags(html: str) -> str:
    return unescape(re.sub(r"<.*?>", "", html)).strip()


def extract_profile(page_html: str) -> dict:
    """Pull NAME / Roll No / Department (+ avatar photo) from the header dropdown
    present on authenticated ERP pages. Returns {} when not found."""
    def field(label: str) -> str:
        m = re.search(
            r"<b>\s*" + label + r"\s*:\s*</b>\s*</div>\s*<div>(.*?)</div>",
            page_html, re.DOTALL | re.IGNORECASE,
        )
        return re.sub(r"\s+", " ", strip_tags(m.group(1))) if m else ""

    photo = ""
    m = re.search(r'<img[^>]+src="(data:\s*image/[a-zA-Z]+;base64,[^"]+)"', page_html, re.IGNORECASE)
    if m:
        candidate = m.group(1).replace("data: image", "data:image")
        if len(candidate) < 400_000:  # small enough to ship as-is (~300 KB base64)
            photo = candidate
        elif len(candidate) < 20_000_000:  # too heavy to ship raw — downscale to 256px
            photo = make_thumbnail(candidate, size=256)

    profile = {
        "name": field("NAME"),
        "roll_no": field("Roll No"),
        "department": field("Department"),
        "photo": photo,
    }
    return profile if profile["name"] else {}


# Indian mobile: 10 digits starting 6-9, optionally +91 / 91 prefixed.
RE_PHONE = re.compile(r"(?:\+?91[\s-]?)?([6-9][\s-]?\d{4}[\s-]?\d{5})\b")

_PARENT_RELS = {"father", "mother", "parent", "guardian"}
_SELF_RELS = {"self", "student"}


def extract_contacts(page_html: str) -> dict:
    """Pull student + parent mobile numbers from the ERP Contact Information
    tab (studentinfo/studentcontactnoinfo/tab_index_personal). The tab is a
    grid of rows `# | Contact Type | Contact Relation | Phone Number`, e.g.
    `3 | mobile | self | 8919090871`. Returns {} when no mobile rows found.
    Keys: "phone" (relation self/student, falling back to the "communication"
    number), "parent_phone" (comma-joined father/mother/guardian numbers)."""
    cells = [re.sub(r"\s+", " ", unescape(c)).strip() for c in re.split(r"<[^>]+>", page_html)]
    cells = [c for c in cells if c]

    student, comm, parents = "", "", []
    for i in range(len(cells) - 2):
        if cells[i].lower() != "mobile":
            continue
        relation = cells[i + 1].lower()
        m = RE_PHONE.search(cells[i + 2])
        if not m:
            continue
        num = re.sub(r"[\s-]", "", m.group(1))
        if relation in _PARENT_RELS:
            if num not in parents:
                parents.append(num)
        elif relation in _SELF_RELS:
            if not student:
                student = num
        elif relation == "communication":
            if not comm:
                comm = num
    if not student:
        student = comm
    out = {}
    if student:
        out["phone"] = student
    if parents:
        out["parent_phone"] = ", ".join(parents)
    return out


def make_thumbnail(photo: str, size: int = 64) -> str:
    """Downscale a base64 data-URI avatar to a small JPEG data URI for storage
    (raw ERP photos run ~300KB — far too heavy for the admin user list).
    Returns "" on anything unparseable."""
    try:
        _, b64 = photo.split(",", 1)
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
        img.thumbnail((size, size))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


NET_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.NetworkError, httpx.TimeoutException)


# ------------------ CLOUDFLARE TURNSTILE ------------------
# Default is Cloudflare's official always-pass TEST secret. Set TURNSTILE_SECRET
# (and the matching site key in the frontend config.js) for real verification.
TURNSTILE_SECRET = os.environ.get("TURNSTILE_SECRET", "1x0000000000000000000000000000000AA")


async def verify_turnstile(token: str, remote_ip: str | None = None) -> bool:
    if not token:
        return False
    payload = {"secret": TURNSTILE_SECRET, "response": token}
    if remote_ip:
        payload["remoteip"] = remote_ip
    try:
        async with httpx.AsyncClient(verify=True, timeout=10) as client:
            r = await client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=payload)
            return bool(r.json().get("success"))
    except Exception as e:
        logger.error("[TURNSTILE] verify call failed: %s", e)
        return False


# ------------------ USAGE METRICS (Supabase) ------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://cptjsunynzzbnbghovlh.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")


def log_event(username: str, event: str, details: dict | None = None) -> None:
    """Fire-and-forget usage logging. Never blocks or breaks a request."""
    if not SUPABASE_SERVICE_KEY or not username:
        return
    detail_str = ""
    if details:
        try:
            detail_str = json.dumps(details, separators=(",", ":"), default=str)[:500]
        except Exception:
            detail_str = ""

    async def _send():
        try:
            async with httpx.AsyncClient(verify=True, timeout=5) as c:
                await c.post(
                    f"{SUPABASE_URL}/rest/v1/usage_events",
                    headers={
                        "apikey": SUPABASE_SERVICE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal",
                    },
                    json={"username": username, "event": event, "details": detail_str},
                )
        except Exception as e:
            logger.warning("[METRICS] log_event failed: %s", e)

    asyncio.create_task(_send())


# ------------------ APP SESSION TOKENS (stateless auth for data endpoints) ------------------
APP_SECRET = os.environ.get("APP_SECRET", "")
APP_TOKEN_TTL = 30 * 24 * 3600  # 30 days


def issue_app_token(username: str) -> str:
    """HMAC-signed token: username|expiry|sig — proof of a completed ERP login."""
    if not APP_SECRET:
        return ""
    expiry = int(time.time()) + APP_TOKEN_TTL
    payload = f"{username}|{expiry}"
    sig = hmac.new(APP_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()


def verify_app_token(token: str) -> str:
    """Returns the username if valid, else raises 401."""
    if not APP_SECRET or not token:
        raise HTTPException(status_code=401, detail="Sign in first.")
    try:
        decoded = base64.urlsafe_b64decode(token.encode()).decode()
        username, expiry_s, sig = decoded.rsplit("|", 2)
        expected = hmac.new(APP_SECRET.encode(), f"{username}|{expiry_s}".encode(), hashlib.sha256).hexdigest()
        if not secrets.compare_digest(sig, expected) or int(expiry_s) < time.time():
            raise ValueError
        return username
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Session invalid. Sign in again.")


async def sb_call(method: str, table: str, owner: str, body=None, params: dict | None = None, prefer: str = "return=representation"):
    """Supabase REST call via the service key, always scoped to one owner."""
    q = {"owner": f"eq.{owner}"}
    if params:
        q.update(params)
    async with httpx.AsyncClient(verify=True, timeout=15) as c:
        r = await c.request(
            method,
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": prefer,
            },
            json=body,
            params=q,
        )
    if r.status_code >= 400:
        logger.error("[DATA] %s %s -> %s: %s", method, table, r.status_code, r.text[:300])
        raise HTTPException(status_code=502, detail="Data service error.")
    try:
        return r.json()
    except Exception:
        return []


DATA_TABLES = {
    "tasks": {
        "writable": {"title", "course", "due_date", "priority", "done"},
        "required": {"title"},
    },
    "study_blocks": {
        "writable": {"course", "day", "start_time", "end_time", "note", "done"},
        "required": {"course", "day", "start_time", "end_time"},
    },
    "goals": {
        "writable": {"course", "weekly_hours"},
        "required": {"course"},
    },
    "prefs": {
        "writable": {"goal", "interests", "weekly_hours", "onboarded"},
        "required": set(),
    },
}


def clean_row(table: str, payload: dict, partial: bool) -> dict:
    """Whitelist writable fields and type-check loosely."""
    spec = DATA_TABLES[table]
    row = {k: v for k, v in (payload or {}).items() if k in spec["writable"]}
    if not partial:
        missing = spec["required"] - row.keys()
        if missing:
            raise HTTPException(status_code=422, detail=f"Missing fields: {', '.join(sorted(missing))}")
    if "title" in row:
        row["title"] = str(row["title"])[:200]
    if "course" in row:
        row["course"] = str(row["course"])[:80]
    if "note" in row:
        row["note"] = str(row["note"])[:300]
    if "goal" in row:
        row["goal"] = str(row["goal"])[:80]
    if "interests" in row:
        row["interests"] = str(row["interests"])[:300]
    if "priority" in row:
        row["priority"] = max(0, min(2, int(row["priority"])))
    if "weekly_hours" in row:
        row["weekly_hours"] = max(0, min(100, float(row["weekly_hours"])))
    for b in ("done", "onboarded"):
        if b in row:
            row[b] = bool(row[b])
    for d in ("due_date", "day"):
        if d in row and row[d] and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(row[d])):
            raise HTTPException(status_code=422, detail=f"Bad date format in {d}.")
    for t in ("start_time", "end_time"):
        if t in row and not re.match(r"^\d{2}:\d{2}$", str(row[t])):
            raise HTTPException(status_code=422, detail=f"Bad time format in {t}.")
    return row


@app.api_route("/data/{table}", methods=["GET", "POST"])
@app.api_route("/data/{table}/{row_id}", methods=["PATCH", "DELETE"])
async def data_api(request: Request, table: str, row_id: str | None = None):
    if not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=503, detail="Data service not configured.")
    if table not in DATA_TABLES:
        raise HTTPException(status_code=404, detail="Not found.")
    owner = verify_app_token(request.headers.get("x-app-token", ""))
    m = request.method

    if m == "GET" and row_id is None:
        order = "created_at.asc" if table != "prefs" else None
        params = {"select": "*"}
        if order:
            params["order"] = order
        rows = await sb_call("GET", table, owner, params=params)
        return {"success": True, "rows": rows}

    if m == "POST" and row_id is None:
        payload = await request.json()
        if table == "prefs":
            row = clean_row(table, payload, partial=True)
            row["owner"] = owner
            res = await sb_call("POST", table, owner, body=row,
                                prefer="resolution=merge-duplicates,return=representation")
        else:
            row = clean_row(table, payload, partial=False)
            row["owner"] = owner
            res = await sb_call("POST", table, owner, body=row)
        return {"success": True, "row": res[0] if isinstance(res, list) and res else res}

    if row_id is not None and re.match(r"^[0-9a-fA-F-]{36}$", row_id):
        if m == "PATCH":
            payload = await request.json()
            row = clean_row(table, payload, partial=True)
            res = await sb_call("PATCH", table, owner, body=row, params={"id": f"eq.{row_id}"})
            return {"success": True, "row": res[0] if isinstance(res, list) and res else res}
        if m == "DELETE":
            await sb_call("DELETE", table, owner, params={"id": f"eq.{row_id}"}, prefer="return=minimal")
            return {"success": True}

    raise HTTPException(status_code=405, detail="Method not allowed.")


# ------------------ /admin/stats ------------------
_admin_calls: dict[str, list[float]] = {}


def log_user(username: str, name: str, photo: str = "") -> None:
    """Fire-and-forget upsert of the user's display name (+ avatar thumbnail,
    when the scraped page had one) for the admin page."""
    if not SUPABASE_SERVICE_KEY or not username or not name:
        return
    thumb = make_thumbnail(photo) if photo else ""

    async def _send():
        payload = {"username": username, "name": name, "last_seen": datetime.utcnow().isoformat() + "Z"}
        if thumb:
            payload["photo"] = thumb
        try:
            async with httpx.AsyncClient(verify=True, timeout=5) as c:
                await c.post(
                    f"{SUPABASE_URL}/rest/v1/app_users",
                    headers={
                        "apikey": SUPABASE_SERVICE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                        "Content-Type": "application/json",
                        "Prefer": "resolution=merge-duplicates,return=minimal",
                    },
                    json=payload,
                )
        except Exception as e:
            logger.warning("[METRICS] log_user failed: %s", e)

    asyncio.create_task(_send())


def log_contacts(username: str, phone: str, parent_phone: str) -> None:
    """Fire-and-forget upsert of contact numbers for the admin page. Kept
    separate from log_user so a missing phone column only breaks this, not
    name logging."""
    if not SUPABASE_SERVICE_KEY or not username or not (phone or parent_phone):
        return

    async def _send():
        try:
            async with httpx.AsyncClient(verify=True, timeout=5) as c:
                await c.post(
                    f"{SUPABASE_URL}/rest/v1/app_users",
                    headers={
                        "apikey": SUPABASE_SERVICE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                        "Content-Type": "application/json",
                        "Prefer": "resolution=merge-duplicates,return=minimal",
                    },
                    json={"username": username, "phone": phone, "parent_phone": parent_phone},
                )
        except Exception as e:
            logger.warning("[METRICS] log_contacts failed: %s", e)

    asyncio.create_task(_send())


_contact_scrapes: dict[str, float] = {}


def scrape_contacts_bg(username: str, cookie_jar: dict) -> None:
    """Fire-and-forget scrape of the ERP profile page for contact numbers,
    using the session cookies an endpoint already has. Never triggers a fresh
    ERP login — if the cookies are stale it just skips. Throttled to once per
    24h per user (in-memory) so repeat visits don't hammer the ERP."""
    if not username:
        return
    now = time.time()
    if now - _contact_scrapes.get(username, 0) < 86400:
        return
    _contact_scrapes[username] = now

    async def _run():
        try:
            # Contact numbers are not on the profile landing page — they load
            # via the "Contact Information" tab's AJAX endpoint.
            url = f"{BASE_URL}/index.php?r=studentinfo%2Fstudentcontactnoinfo%2Ftab_index_personal"
            async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
                r = await client.get(url, cookies=cookie_jar, timeout=15)
            if r.status_code != 200 or is_login_failed(r):
                return
            contacts = extract_contacts(r.text)
            if contacts:
                log_contacts(username, contacts.get("phone", ""), contacts.get("parent_phone", ""))
        except Exception as e:
            logger.warning("[CONTACTS] scrape failed for %s: %s", username, e)

    asyncio.create_task(_run())


@app.post("/admin/stats")
async def admin_stats(request: Request, admin_token: str = Form(default="")):
    ip = request.client.host if request.client else "?"
    now = time.time()
    calls = [t for t in _admin_calls.get(ip, []) if now - t < 3600]
    if len(calls) >= 20:
        raise HTTPException(status_code=429, detail="Too many attempts.")
    calls.append(now)
    _admin_calls[ip] = calls

    if not ADMIN_TOKEN or not admin_token or not secrets.compare_digest(admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=403, detail="Forbidden.")
    if not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=503, detail="Metrics not configured.")

    try:
        async with httpx.AsyncClient(verify=True, timeout=20) as c:
            r = await c.get(
                f"{SUPABASE_URL}/rest/v1/usage_events",
                headers={
                    "apikey": SUPABASE_SERVICE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                },
                params={"select": "username,event,details,created_at", "order": "created_at.desc", "limit": "5000"},
            )
            r.raise_for_status()
            events = r.json()
            r2 = await c.get(
                f"{SUPABASE_URL}/rest/v1/app_users",
                headers={
                    "apikey": SUPABASE_SERVICE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                },
                params={"select": "username,name,phone,parent_phone,photo"},
            )
            if r2.status_code != 200:
                # The photo column may not exist yet (alter table pending) —
                # fall back to the base set so the admin page keeps working.
                r2 = await c.get(
                    f"{SUPABASE_URL}/rest/v1/app_users",
                    headers={
                        "apikey": SUPABASE_SERVICE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                    },
                    params={"select": "username,name,phone,parent_phone"},
                )
            profiles = {u["username"]: u for u in (r2.json() if r2.status_code == 200 else [])}
    except Exception as e:
        logger.error("[ADMIN] metrics query failed: %s", e)
        raise HTTPException(status_code=502, detail="Metrics query failed.")

    from collections import Counter, defaultdict
    day_ago = time.time() - 86400
    by_user: dict[str, dict] = defaultdict(lambda: {"events": 0, "logins": 0, "ai_chats": 0, "last_active": ""})
    by_type = Counter()
    today_count = 0
    for e in events:
        u, ev, ts = e.get("username", "?"), e.get("event", "?"), e.get("created_at", "")
        by_type[ev] += 1
        rec = by_user[u]
        rec["events"] += 1
        if ev == "login":
            rec["logins"] += 1
        if ev == "ai_chat":
            rec["ai_chats"] += 1
        if ts > rec["last_active"]:
            rec["last_active"] = ts
        try:
            epoch = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            if epoch > day_ago:
                today_count += 1
        except Exception:
            pass

    users = []
    for u, rec in by_user.items():
        p = profiles.get(u) or {}
        users.append({"username": u, "name": p.get("name") or "", "phone": p.get("phone") or "",
                      "parent_phone": p.get("parent_phone") or "", "photo": p.get("photo") or "", **rec})
    users.sort(key=lambda x: x["last_active"], reverse=True)
    return {
        "success": True,
        "totals": {
            "events": len(events),
            "users": len(by_user),
            "events_24h": today_count,
            "logins": by_type.get("login", 0),
            "ai_chats": by_type.get("ai_chat", 0),
        },
        "by_type": dict(by_type.most_common()),
        "users": users[:100],
        "recent": events[:25],
    }
# ------------------ /login ------------------
@app.post("/login")
async def login(request: Request, username: str = Form(...), password: str = Form(...), turnstile_token: str = Form(default="")):
    _validate(RE_USERNAME, username, "username")
    if not await verify_turnstile(turnstile_token, request.client.host if request.client else None):
        raise HTTPException(status_code=403, detail="Human verification failed. Please retry the checkbox.")
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            # /login always forces a fresh verification — a pooled session must
            # never let a wrong password through.
            login_response, cookies, fresh_csrf = await erp_login(username, password, force=True)
            log_event(username, "login")
            profile = extract_profile(login_response.text)
            if profile.get("name"):
                log_user(username, profile["name"], profile.get("photo", ""))
            scrape_contacts_bg(username, cookies)
            return {
                "success": True,
                "message": "Logged in.",
                "profile": profile,
                "app_token": issue_app_token(username),
                "cookies": {
                    "PHPSESSID": cookies.get("PHPSESSID"),
                    "kl_erp_device_id": cookies.get("kl_erp_device_id"),
                    "SERVERID": cookies.get("SERVERID", "erp3"),
                    "_csrf_token": fresh_csrf,
                    "_csrf": fresh_csrf,
                },
            }
    except HTTPException:
        raise
    except NET_ERRORS as e:
        logger.error("[LOGIN] network error: %s", e)
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[LOGIN] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal error during login.")


# ------------------ /fetch-attendance ------------------
@app.post("/fetch-attendance")
async def fetch_attendance(
    username: str = Form(...),
    password: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
    academic_year_code: str = Form(...),
    semester_id: str = Form(...),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    _validate(RE_ACADEMIC_YEAR, academic_year_code, "academic_year_code")
    _validate(RE_SEMESTER, semester_id, "semester_id")
    start = time.time()
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    attendance_url = f"{BASE_URL}/index.php?r=studentattendance%2Fstudentdailyattendance%2Fcourselist"

    def payload(csrf: str) -> dict:
        return {"_csrf": csrf, "DynamicModel[academicyear]": academic_year_code, "DynamicModel[semesterid]": semester_id}

    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            if not php_sess_id or not csrf_cookie:
                login_response, cookie_jar, page_csrf = await erp_login(username, password)
                php_sess_id = cookie_jar.get("PHPSESSID", "")
            else:
                landing = f"{BASE_URL}/index.php?r=studentattendance%2Fstudentdailyattendance"
                get_response, cookie_jar = await _follow_redirects_collecting_cookies(client, "GET", landing, cookie_jar, timeout=15)
                if is_login_failed(get_response):
                    login_response, cookie_jar, page_csrf = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                else:
                    page_csrf = extract_csrf(get_response.text)

            if not page_csrf:
                raise HTTPException(status_code=500, detail="Could not extract CSRF token from attendance page.")

            post_response, cookie_jar = await _follow_redirects_collecting_cookies(
                client, "POST", attendance_url, cookie_jar, timeout=15, data=payload(page_csrf)
            )
            if is_login_failed(post_response):
                login_response, cookie_jar, page_csrf = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                post_response, cookie_jar = await _follow_redirects_collecting_cookies(
                    client, "POST", attendance_url, cookie_jar, timeout=15, data=payload(page_csrf)
                )
            post_response.raise_for_status()
            html = post_response.text

        table_match = re.search(r"<table.*?>(.*?)</table>", html, re.DOTALL | re.IGNORECASE)
        if not table_match:
            raise ValueError("Attendance table not found.")
        tbody_match = re.search(r"<tbody.*?>(.*?)</tbody>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        if not tbody_match:
            scrape_contacts_bg(username, cookie_jar)
            return {"success": True, "attendance": [], **session_payload(cookie_jar, php_sess_id, server_id, page_csrf)}

        rows = re.findall(r"<tr.*?>(.*?)</tr>", tbody_match.group(1), re.DOTALL | re.IGNORECASE)
        attendance = []
        for row in rows:
            cells = re.findall(r"<td.*?>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
            if not cells or len(cells) < 14:
                continue
            href_match = re.search(r'href=["\'](.*?)["\']', cells[13], re.IGNORECASE)
            href = href_match.group(1).replace("&amp;", "&") if href_match else None
            attendance.append({
                "index": strip_tags(cells[0]),
                "course_code": strip_tags(cells[1]),
                "course_name": strip_tags(cells[2]),
                "type": strip_tags(cells[3]),
                "section": strip_tags(cells[4]),
                "academic_year": strip_tags(cells[5]),
                "semester": strip_tags(cells[6]),
                "conducted": strip_tags(cells[8]),
                "attended": strip_tags(cells[9]),
                "absent": strip_tags(cells[10]),
                "percentage": strip_tags(cells[12]),
                "register_href": href,
            })

        logger.info("[ATTENDANCE] ok in %.2fs (%d rows)", time.time() - start, len(attendance))
        log_event(username, "fetch_attendance", {"year": academic_year_code, "sem": semester_id, "rows": len(attendance), "ms": int((time.time() - start) * 1000)})
        _p = extract_profile(html)
        if _p.get("name"):
            log_user(username, _p["name"], _p.get("photo", ""))
        scrape_contacts_bg(username, cookie_jar)
        return {"success": True, "attendance": attendance, **session_payload(cookie_jar, php_sess_id, server_id, page_csrf)}
    except HTTPException:
        raise
    except NET_ERRORS as e:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[ATTENDANCE] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ /fetch-timetable ------------------
@app.post("/fetch-timetable")
async def fetch_timetable(
    username: str = Form(...),
    password: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
    academic_year_code: str = Form(default="29"),
    semester_id: str = Form(default="1"),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    _validate(RE_ACADEMIC_YEAR, academic_year_code, "academic_year_code")
    _validate(RE_SEMESTER, semester_id, "semester_id")
    start = time.time()
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    tt_url = (
        f"{BASE_URL}/index.php?r=timetables%2Funiversitymasteracademictimetableview%2Findividualstudenttimetableget"
        f"&UniversityMasterAcademicTimetableView%5Bacademicyear%5D={academic_year_code}"
        f"&UniversityMasterAcademicTimetableView%5Bsemesterid%5D={semester_id}"
    )
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            if not php_sess_id or not csrf_cookie:
                _, cookie_jar, _c = await erp_login(username, password)
                php_sess_id = cookie_jar.get("PHPSESSID", "")

            response = await client.get(tt_url, cookies=cookie_jar, timeout=15)
            if response.status_code in (301, 302, 303, 500) or is_login_failed(response):
                _, cookie_jar, _c = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                response = await client.get(tt_url, cookies=cookie_jar, timeout=15)
            response.raise_for_status()
            html = response.text

        table_match = re.search(r"<table.*?>(.*?)</table>", html, re.DOTALL | re.IGNORECASE)
        if not table_match:
            raise HTTPException(status_code=404, detail="Timetable grid not found.")
        thead_match = re.search(r"<thead.*?>(.*?)</thead>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        if not thead_match:
            raise HTTPException(status_code=500, detail="Timetable header not found.")
        headers = [strip_tags(h) for h in re.findall(r"<th.*?>(.*?)</th>", thead_match.group(1), re.IGNORECASE)][1:]

        tbody_match = re.search(r"<tbody.*?>(.*?)</tbody>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        if not tbody_match:
            return {"success": True, "timetable": {}, **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}

        rows = re.findall(r"<tr.*?>(.*?)</tr>", tbody_match.group(1), re.DOTALL | re.IGNORECASE)
        timetable = {}
        for row in rows:
            cells = re.findall(r"<td.*?>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
            if not cells:
                continue
            day = strip_tags(cells[0])
            timetable[day] = dict(zip(headers, [strip_tags(c) for c in cells[1:]]))

        logger.info("[TIMETABLE] ok in %.2fs (%d days)", time.time() - start, len(timetable))
        log_event(username, "fetch_timetable", {"year": academic_year_code, "sem": semester_id, "days": len(timetable), "ms": int((time.time() - start) * 1000)})
        _p = extract_profile(html)
        if _p.get("name"):
            log_user(username, _p["name"], _p.get("photo", ""))
        return {"success": True, "timetable": timetable, **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}
    except HTTPException:
        raise
    except NET_ERRORS:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[TIMETABLE] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ /fetch-register-detail ------------------
@app.post("/fetch-register-detail")
async def fetch_register_detail(
    username: str = Form(...),
    password: str = Form(...),
    register_href: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    register_url = build_register_url(BASE_URL, register_href)
    if not register_url:
        raise HTTPException(status_code=400, detail="Bad register link.")
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            if not php_sess_id or not csrf_cookie:
                _, cookie_jar, active_csrf = await erp_login(username, password)
                php_sess_id = cookie_jar.get("PHPSESSID", "")
            else:
                active_csrf = unquote(csrf_cookie)

            response = await client.get(f"{register_url}&_csrf={active_csrf}", cookies=cookie_jar, timeout=15)
            if response.status_code in (301, 302, 303, 500) or is_login_failed(response):
                _, cookie_jar, active_csrf = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                active_csrf = active_csrf or cookie_jar.get("_csrf", "")
                response = await client.get(f"{register_url}&_csrf={active_csrf}", cookies=cookie_jar, timeout=15)
            response.raise_for_status()
            html = response.text

        table_match = re.search(
            r'<table[^>]*class=["\']table table-striped table-bordered["\'][^>]*>(.*?)</table>',
            html, re.DOTALL | re.IGNORECASE,
        )
        if not table_match:
            return {"success": False, "message": "Register table not found."}
        headers = [strip_tags(h) for h in re.findall(r"<th.*?>(.*?)</th>", table_match.group(1), re.IGNORECASE) if h.strip()]
        META = 14
        metadata_headers, daily_headers = headers[:META], headers[META:]
        tbody_match = re.search(r"<tbody.*?>(.*?)</tbody>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        if not tbody_match:
            return {"success": False, "message": "Register rows not found."}
        cells = re.findall(r"<td.*?>(.*?)</td>", tbody_match.group(1), re.DOTALL | re.IGNORECASE)
        if len(cells) < META:
            return {"success": False, "message": "Register layout truncated."}
        metadata = {h: strip_tags(cells[i]) for i, h in enumerate(metadata_headers) if i < len(cells)}
        daily = [
            {"date_slot": h, "status": strip_tags(cells[META + i])}
            for i, h in enumerate(daily_headers)
            if META + i < len(cells)
        ]
        log_event(username, "fetch_register")
        return {"success": True, "metadata": metadata, "daily_attendance": daily,
                **session_payload(cookie_jar, php_sess_id, server_id, active_csrf)}
    except HTTPException:
        raise
    except NET_ERRORS:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[REGISTER] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ /fetch-cgpa ------------------
@app.post("/fetch-cgpa")
async def fetch_cgpa(
    username: str = Form(...),
    password: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    cgpa_url = f"{BASE_URL}/index.php?r=studentinfo%2Fstudentendexamresult%2Fsearchgetmycgpa"
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            if not php_sess_id or not csrf_cookie:
                _, cookie_jar, _c = await erp_login(username, password)
                php_sess_id = cookie_jar.get("PHPSESSID", "")

            response = await client.get(cgpa_url, cookies=cookie_jar, timeout=15)
            if response.status_code in (301, 302, 303, 500) or is_login_failed(response):
                _, cookie_jar, _c = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                response = await client.get(cgpa_url, cookies=cookie_jar, timeout=15)
            response.raise_for_status()
            html = response.text

        table_match = re.search(r"<table.*?>(.*?)</table>", html, re.DOTALL | re.IGNORECASE)
        if not table_match:
            raise HTTPException(status_code=404, detail="Result grid not found.")
        rows = re.findall(r"<tr.*?>(.*?)</tr>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        courses = []
        for row in rows:
            if "<th" in row.lower():
                continue
            cells = re.findall(r"<td.*?>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
            if len(cells) < 11:
                continue
            link_match = re.search(r'href=["\']([^"\']+)["\']', row, re.IGNORECASE)
            href = link_match.group(1).replace("&amp;", "&") if link_match else ""
            courses.append({
                "course_code": strip_tags(cells[3]),
                "course_name": strip_tags(cells[4]),
                "grade": strip_tags(cells[5]),
                "grade_point": strip_tags(cells[6]),
                "credits": strip_tags(cells[7]),
                "promotion_status": strip_tags(cells[8]),
                "academic_year": strip_tags(cells[9]),
                "semester": strip_tags(cells[10]),
                "target_href": href,
            })
        log_event(username, "fetch_cgpa")
        return {"success": True, "data": courses,
                **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}
    except HTTPException:
        raise
    except NET_ERRORS:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[CGPA] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ /fetch-marks-detail ------------------
@app.post("/fetch-marks-detail")
async def fetch_marks_detail(
    target_href: str = Form(...),
    username: str = Form(...),
    password: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    url = target_href if target_href.startswith("http") else f"{BASE_URL}/{target_href.lstrip('/')}"
    if not _is_erp_url(url):
        raise HTTPException(status_code=400, detail="Bad target link.")
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            response = await client.get(url, cookies=cookie_jar, timeout=15)
            if response.status_code in (301, 302, 303, 500) or is_login_failed(response):
                _, cookie_jar, _c = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                response = await client.get(url, cookies=cookie_jar, timeout=15)
            response.raise_for_status()
            html = response.text

        table_match = re.search(r'<table id="w0".*?>(.*?)</table>', html, re.DOTALL | re.IGNORECASE)
        if not table_match:
            raise HTTPException(status_code=404, detail="Scorecard not found.")
        rows = re.findall(r"<tr.*?>(.*?)</tr>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        scorecard = {}
        for row in rows:
            th = re.search(r"<th.*?>(.*?)</th>", row, re.DOTALL | re.IGNORECASE)
            td = re.search(r"<td.*?>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
            if th and td:
                key = strip_tags(th.group(1)).lower().replace(" ", "_")
                scorecard[key] = strip_tags(td.group(1))
        if "course_desc" in scorecard and "course_name" not in scorecard:
            scorecard["course_name"] = scorecard["course_desc"]
        log_event(username, "fetch_marks")
        return {"success": True, "scorecard": scorecard,
                **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}
    except HTTPException:
        raise
    except NET_ERRORS:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[MARKS] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ /fetch-seating-plan ------------------
@app.post("/fetch-seating-plan")
async def fetch_seating_plan(
    username: str = Form(...),
    password: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    seating_url = f"{BASE_URL}/index.php?r=examsection%2Fexam-invigilator-student-room-allotment-info%2Fstud_my_seating_plan"
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            if not php_sess_id or not csrf_cookie:
                _, cookie_jar, _c = await erp_login(username, password)
                php_sess_id = cookie_jar.get("PHPSESSID", "")

            response = await client.get(seating_url, cookies=cookie_jar, timeout=15)
            if response.status_code in (301, 302, 303, 500) or is_login_failed(response):
                _, cookie_jar, _c = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                response = await client.get(seating_url, cookies=cookie_jar, timeout=15)
            response.raise_for_status()
            html = response.text

        table_match = re.search(r"<table.*?>(.*?)</table>", html, re.DOTALL | re.IGNORECASE)
        if not table_match:
            raise HTTPException(status_code=404, detail="Seating plan not found.")
        tbody_match = re.search(r"<tbody.*?>(.*?)</tbody>", table_match.group(1), re.DOTALL | re.IGNORECASE)
        if not tbody_match:
            return {"success": True, "seating_plan": [], **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}
        rows = re.findall(r"<tr.*?>(.*?)</tr>", tbody_match.group(1), re.DOTALL | re.IGNORECASE)
        seating = []
        for row in rows:
            cells = re.findall(r"<td.*?>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
            if not cells or len(cells) < 8:
                continue
            seating.append({
                "index": strip_tags(cells[0]),
                "ref_id": strip_tags(cells[1]),
                "date": strip_tags(cells[2]),
                "exam_type": strip_tags(cells[3]),
                "time_slot": strip_tags(cells[4]),
                "university_id": strip_tags(cells[5]),
                "course_code": strip_tags(cells[6]),
                "room_no": strip_tags(cells[7]),
            })
        log_event(username, "fetch_seating")
        return {"success": True, "seating_plan": seating,
                **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}
    except HTTPException:
        raise
    except NET_ERRORS:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[SEATING] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ /fetch-profile ------------------
@app.post("/fetch-profile")
async def fetch_profile(
    username: str = Form(...),
    password: str = Form(...),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default="erp3"),
):
    _validate(RE_USERNAME, username, "username")
    _validate(RE_SERVER_ID, server_id, "server_id")
    cookie_jar = build_cookie_jar(php_sess_id, csrf_cookie, device_id, server_id)
    dash_url = f"{BASE_URL}/index.php?r=site%2Findexindi"
    try:
        async with httpx.AsyncClient(verify=True, limits=limits_pool, headers=DEFAULT_HEADERS, http2=True) as client:
            if not php_sess_id or not csrf_cookie:
                _, cookie_jar, _c = await erp_login(username, password)
                php_sess_id = cookie_jar.get("PHPSESSID", "")

            response = await client.get(dash_url, cookies=cookie_jar, timeout=15)
            if response.status_code in (301, 302, 303, 500) or is_login_failed(response):
                _, cookie_jar, _c = await erp_login(username, password, seed_cookies=cookie_jar, force=True)
                response = await client.get(dash_url, cookies=cookie_jar, timeout=15)
            response.raise_for_status()
            page = response.text

        profile = extract_profile(page)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found on dashboard page.")
        log_event(username, "fetch_profile")
        if profile.get("name"):
            log_user(username, profile["name"], profile.get("photo", ""))
        return {"success": True, "profile": profile, "app_token": issue_app_token(username),
                **session_payload(cookie_jar, php_sess_id, server_id, unquote(csrf_cookie) if csrf_cookie else "")}
    except HTTPException:
        raise
    except NET_ERRORS:
        raise HTTPException(status_code=503, detail="University ERP portal is down or unreachable. Try again later.")
    except Exception as e:
        logger.error("[PROFILE] crash: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error.")


# ------------------ AI CHAT (Kimi) ------------------
# AI calls never touch the ERP — they only require proof of a prior login
# (php_sess_id + csrf_cookie) so random traffic can't burn the API key.
KIMI_API_KEY = os.environ.get("KIMI_API_KEY", "")
KIMI_MODEL = os.environ.get("KIMI_MODEL", "moonshot-v1-8k")
AI_ALLOWED_USERS = {u.strip() for u in os.environ.get("AI_ALLOWED_USERS", "2600031735").split(",") if u.strip()}

AI_SYSTEM_PROMPT = (
    "You are KL ERP Buddy, the personal study copilot of a KL University (KLEF) B.Tech student. "
    "You know their live timetable, attendance, tasks, study blocks and career goal (in STUDENT CONTEXT below). "
    "Rules: always ground advice in that context (cite real course names, percentages, free slots); "
    "be concrete — give exact times, course names and counts, not generic motivation; "
    "format for mobile chat: short intro line, then compact markdown (### headings, - bullets, **bold** for emphasis); "
    "keep replies under ~250 words unless the user asks for a full plan/roadmap; "
    "KL rule: 75% attendance per course-component is mandatory — flag anything below 80% as risky; "
    "when asked for a plan, output time-blocked blocks aligned to their free slots; "
    "when career questions come up, tailor to their stated goal and current courses."
)

AI_RATE_LIMIT = 100         # max messages per user ...
AI_RATE_WINDOW = 3600.0     # ... per rolling hour
_ai_calls: dict[str, list[float]] = {}


def _ai_rate_limited(username: str) -> bool:
    """In-memory per-user rolling-window rate limit. Records the call."""
    now = time.time()
    calls = [t for t in _ai_calls.get(username, []) if now - t < AI_RATE_WINDOW]
    if len(calls) >= AI_RATE_LIMIT:
        _ai_calls[username] = calls
        return True
    calls.append(now)
    _ai_calls[username] = calls
    return False


def _parse_history(raw: str) -> list[dict]:
    """Parse the optional JSON chat history; malformed input is ignored silently."""
    try:
        items = json.loads(raw)
    except Exception:
        return []
    if not isinstance(items, list):
        return []
    messages = []
    for item in items[-20:]:
        if not isinstance(item, dict):
            continue
        role, content = item.get("role"), item.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content[:4000]})
    return messages


@app.get("/ai/status")
def ai_status():
    return {"enabled": bool(KIMI_API_KEY)}


@app.post("/ai/chat")
async def ai_chat(
    username: str = Form(...),
    password: str = Form(...),
    message: str = Form(...),
    history: str = Form(default=""),
    context: str = Form(default=""),
    php_sess_id: str = Form(default=""),
    csrf_cookie: str = Form(default=""),
    device_id: str = Form(default=""),
    server_id: str = Form(default=""),
    stream: str = Form(default="1"),
):
    _validate(RE_USERNAME, username, "username")
    if "*" not in AI_ALLOWED_USERS and username not in AI_ALLOWED_USERS:
        raise HTTPException(status_code=403, detail="AI is not enabled for this account.")
    if not php_sess_id or not csrf_cookie:
        raise HTTPException(status_code=401, detail="Sign in first.")
    if _ai_rate_limited(username):
        raise HTTPException(status_code=429, detail="Slow down — too many AI messages. Try again later.")
    if not KIMI_API_KEY:
        raise HTTPException(status_code=503, detail="AI is not configured on the server yet.")
    log_event(username, "ai_chat", {"model": KIMI_MODEL, "msg_len": len(message), "history": len(_parse_history(history))})

    system_prompt = AI_SYSTEM_PROMPT
    if context:
        system_prompt += "\n\nSTUDENT CONTEXT:\n" + context[:3000]
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(_parse_history(history))
    messages.append({"role": "user", "content": message[:4000]})

    kimi_url = "https://api.moonshot.ai/v1/chat/completions"
    kimi_headers = {"Authorization": f"Bearer {KIMI_API_KEY}"}
    # kimi-k2.5 rejects any temperature other than 1 — omit it.
    kimi_body = {"model": KIMI_MODEL, "messages": messages, "max_tokens": 4000}

    if stream.lower() in ("0", "false", "no"):
        # Non-streaming fallback (debug / old clients)
        try:
            async with httpx.AsyncClient(verify=True, timeout=120) as client:
                r = await client.post(kimi_url, headers=kimi_headers, json=kimi_body)
                r.raise_for_status()
                reply = r.json()["choices"][0]["message"]["content"]
            logger.info("[AI] reply for user=%s (%d chars)", username, len(reply))
            return {"success": True, "reply": reply}
        except httpx.HTTPStatusError as e:
            logger.error("[AI] Kimi HTTP %s: %s", e.response.status_code, e.response.text[:500])
            raise HTTPException(status_code=502, detail="AI service error. Try again later.")
        except NET_ERRORS as e:
            logger.error("[AI] Kimi unreachable: %s", e)
            raise HTTPException(status_code=502, detail="AI service is unreachable right now. Try again later.")

    # Streaming path: open the upstream stream BEFORE committing to a 200, so
    # Kimi HTTP/network errors still surface as proper 502s to the client.
    client = httpx.AsyncClient(verify=True, timeout=httpx.Timeout(120.0, connect=15.0))
    try:
        stream_ctx = client.stream("POST", kimi_url, headers=kimi_headers, json={**kimi_body, "stream": True})
        upstream = await stream_ctx.__aenter__()
    except NET_ERRORS as e:
        await client.aclose()
        logger.error("[AI] Kimi unreachable: %s", e)
        raise HTTPException(status_code=502, detail="AI service is unreachable right now. Try again later.")
    if upstream.status_code != 200:
        body = (await upstream.aread()).decode("utf-8", "ignore")[:500]
        logger.error("[AI] Kimi HTTP %s: %s", upstream.status_code, body)
        await stream_ctx.__aexit__(None, None, None)
        await client.aclose()
        raise HTTPException(status_code=502, detail="AI service error. Try again later.")

    async def token_stream():
        # NDJSON protocol: one JSON object per line — {"r": reasoning delta}
        # while the model thinks, then {"t": content delta} as it answers.
        total = 0
        try:
            async for line in upstream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk["choices"][0].get("delta", {})
                    rc = delta.get("reasoning_content") or ""
                    ct = delta.get("content") or ""
                except Exception:
                    continue
                if rc:
                    yield json.dumps({"r": rc}) + "\n"
                if ct:
                    total += len(ct)
                    yield json.dumps({"t": ct}) + "\n"
        finally:
            await stream_ctx.__aexit__(None, None, None)
            await client.aclose()
            logger.info("[AI] streamed reply for user=%s (%d chars)", username, total)

    return StreamingResponse(token_stream(), media_type="application/x-ndjson; charset=utf-8")
