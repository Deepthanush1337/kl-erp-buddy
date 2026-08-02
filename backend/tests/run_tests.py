"""
KL ERP Buddy - API E2E test suite.

Tests the RUNNING local backend at http://127.0.0.1:8000 against the real KL
University ERP with the owner's test account. No mocks: this exercises the
actual captcha-solving login and HTML scraping paths, so it needs network
access to newerp.kluniversity.in and can take a minute or two.

Run:  backend/.venv/Scripts/python.exe backend/tests/run_tests.py
Exit: 0 = all tests passed, 1 = at least one failure/error.
"""

import os
import sys
import time
import traceback

import httpx

BASE_URL = os.environ.get("KL_ERP_API", "http://127.0.0.1:8000")
USERNAME = os.environ.get("KL_ERP_USERNAME", "")
PASSWORD = os.environ.get("KL_ERP_PASSWORD", "")
if not USERNAME or not PASSWORD:
    sys.exit("Set KL_ERP_USERNAME and KL_ERP_PASSWORD env vars (your own ERP creds) to run these tests.")
WRONG_PASSWORD = "definitely-wrong-password-000"
ACADEMIC_YEAR_CODE = "29"  # 2026-27
SEMESTER_ID = "1"          # odd semester
TIMEOUT = 240.0            # captcha login = several ERP round-trips + retries

results = []  # list of (name, passed, detail, elapsed_seconds)


def record(name: str, passed: bool, detail: str, elapsed: float) -> None:
    results.append((name, passed, detail, elapsed))
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name} ({elapsed:.2f}s) - {detail}", flush=True)


def run_test(name: str, fn) -> None:
    """Run one test with per-test timing; fn returns a detail string on success."""
    start = time.perf_counter()
    try:
        detail = fn()
        record(name, True, detail, time.perf_counter() - start)
    except AssertionError as e:
        record(name, False, f"assertion failed: {e}", time.perf_counter() - start)
    except Exception:
        detail = "unexpected error: " + traceback.format_exc(limit=2).replace("\n", " | ")
        record(name, False, detail, time.perf_counter() - start)


def session_fields(cookies: dict) -> dict:
    """Map a /login cookies object onto the form fields the fetch endpoints take."""
    return {
        "php_sess_id": cookies.get("PHPSESSID") or "",
        "csrf_cookie": cookies.get("_csrf") or "",
        "device_id": cookies.get("kl_erp_device_id") or "",
        "server_id": cookies.get("SERVERID") or "erp3",
    }


def main() -> int:
    print(f"KL ERP Buddy E2E tests - target {BASE_URL}", flush=True)
    print("-" * 72, flush=True)
    client = httpx.Client(timeout=TIMEOUT)
    state = {"cookies": None}  # filled by the login test, reused by fetch tests

    # (1) GET / - health + captcha model loaded
    def t_health() -> str:
        r = client.get(f"{BASE_URL}/")
        assert r.status_code == 200, f"status {r.status_code}"
        body = r.json()
        assert body.get("captcha_model") is True, f"captcha_model={body.get('captcha_model')!r}"
        return f"captcha_model=true, status={body.get('status')!r}"

    # (2) POST /login with valid creds - success + PHPSESSID cookie
    def t_login_ok() -> str:
        r = client.post(f"{BASE_URL}/login", data={"username": USERNAME, "password": PASSWORD})
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("success") is True, f"success={body.get('success')!r}"
        cookies = body.get("cookies") or {}
        assert cookies.get("PHPSESSID"), f"no PHPSESSID in cookies: {list(cookies)}"
        state["cookies"] = cookies
        return f"success=true, PHPSESSID={cookies['PHPSESSID'][:8]}..."

    # (3) POST /login with wrong password - 401
    def t_login_bad() -> str:
        r = client.post(f"{BASE_URL}/login", data={"username": USERNAME, "password": WRONG_PASSWORD})
        assert r.status_code == 401, f"status {r.status_code}, expected 401: {r.text[:200]}"
        return "rejected with 401 as expected"

    # (4) POST /fetch-timetable with session cookies - success, non-empty, has Mon
    def t_timetable() -> str:
        assert state["cookies"], "no session cookies (login test must pass first)"
        data = {"username": USERNAME, "password": PASSWORD,
                "academic_year_code": ACADEMIC_YEAR_CODE, "semester_id": SEMESTER_ID,
                **session_fields(state["cookies"])}
        r = client.post(f"{BASE_URL}/fetch-timetable", data=data)
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("success") is True, f"success={body.get('success')!r}"
        tt = body.get("timetable")
        assert isinstance(tt, dict) and tt, f"timetable empty/not a dict: {type(tt).__name__}"
        assert "Mon" in tt, f"'Mon' not in timetable days: {list(tt)}"
        state["tt_cookies"] = body.get("cookies") or state["cookies"]
        return f"success=true, days={list(tt)}, session_refreshed={body.get('session_refreshed')}"

    # (5) POST /fetch-attendance - success (fresher account: attendance may be [])
    def t_attendance() -> str:
        assert state["cookies"], "no session cookies (login test must pass first)"
        data = {"username": USERNAME, "password": PASSWORD,
                "academic_year_code": ACADEMIC_YEAR_CODE, "semester_id": SEMESTER_ID,
                **session_fields(state.get("tt_cookies") or state["cookies"])}
        r = client.post(f"{BASE_URL}/fetch-attendance", data=data)
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("success") is True, f"success={body.get('success')!r}"
        attendance = body.get("attendance")
        assert isinstance(attendance, list), f"attendance not a list: {type(attendance).__name__}"
        return f"success=true, rows={len(attendance)} (fresher account, [] is valid)"

    # (6a) POST /fetch-cgpa - success, data is a list (may be empty)
    def t_cgpa() -> str:
        assert state["cookies"], "no session cookies (login test must pass first)"
        data = {"username": USERNAME, "password": PASSWORD,
                **session_fields(state.get("tt_cookies") or state["cookies"])}
        r = client.post(f"{BASE_URL}/fetch-cgpa", data=data)
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("success") is True, f"success={body.get('success')!r}"
        assert isinstance(body.get("data"), list), f"data not a list: {type(body.get('data')).__name__}"
        return f"success=true, courses={len(body['data'])}"

    # (6b) POST /fetch-seating-plan - success, seating_plan is a list (may be empty)
    def t_seating() -> str:
        assert state["cookies"], "no session cookies (login test must pass first)"
        data = {"username": USERNAME, "password": PASSWORD,
                **session_fields(state.get("tt_cookies") or state["cookies"])}
        r = client.post(f"{BASE_URL}/fetch-seating-plan", data=data)
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("success") is True, f"success={body.get('success')!r}"
        plan = body.get("seating_plan")
        assert isinstance(plan, list), f"seating_plan not a list: {type(plan).__name__}"
        return f"success=true, entries={len(plan)}"

    # (7) POST /fetch-timetable with garbage cookies - auto re-login, session_refreshed=true
    def t_timetable_garbage() -> str:
        data = {"username": USERNAME, "password": PASSWORD,
                "academic_year_code": ACADEMIC_YEAR_CODE, "semester_id": SEMESTER_ID,
                "php_sess_id": "garbage-session-id", "csrf_cookie": "garbage-csrf",
                "device_id": "garbage-device", "server_id": "erp3"}
        r = client.post(f"{BASE_URL}/fetch-timetable", data=data)
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("success") is True, f"success={body.get('success')!r}"
        assert body.get("session_refreshed") is True, \
            f"session_refreshed={body.get('session_refreshed')!r}, expected auto re-login"
        tt = body.get("timetable")
        assert isinstance(tt, dict) and tt, "timetable empty after re-login"
        return "success=true, session_refreshed=true (auto re-login path worked)"

    # (8) POST /fetch-attendance missing academic_year_code - 422
    def t_attendance_422() -> str:
        data = {"username": USERNAME, "password": PASSWORD, "semester_id": SEMESTER_ID}
        r = client.post(f"{BASE_URL}/fetch-attendance", data=data)
        assert r.status_code == 422, f"status {r.status_code}, expected 422: {r.text[:200]}"
        return "rejected with 422 as expected"

    tests = [
        ("GET / health", t_health),
        ("POST /login valid creds", t_login_ok),
        ("POST /login wrong password", t_login_bad),
        ("POST /fetch-timetable", t_timetable),
        ("POST /fetch-attendance", t_attendance),
        ("POST /fetch-cgpa", t_cgpa),
        ("POST /fetch-seating-plan", t_seating),
        ("POST /fetch-timetable garbage cookies", t_timetable_garbage),
        ("POST /fetch-attendance missing academic_year_code", t_attendance_422),
    ]
    for name, fn in tests:
        run_test(name, fn)

    # (9) timing report + final summary
    print("-" * 72, flush=True)
    print("TIMING REPORT (per call)", flush=True)
    for name, _, _, elapsed in results:
        print(f"  {elapsed:8.2f}s  {name}", flush=True)
    total = sum(e for _, _, _, e in results)
    passed = sum(1 for _, ok, _, _ in results if ok)
    print("-" * 72, flush=True)
    print(f"SUMMARY: {passed}/{len(results)} passed, {len(results) - passed} failed, "
          f"total {total:.2f}s", flush=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
