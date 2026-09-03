"""
Offline unit tests for main.extract_profile() photo handling: oversized
avatars must be DOWNSCALED, not dropped (a real account had a ~600KB base64
photo that the old 400KB cap silently rejected).

No network needed. Run from anywhere:
    backend/.venv/Scripts/python.exe backend/tests/test_extract_profile.py
Exit: 0 = all passed, 1 = at least one failure.
"""

import base64
import io
import os
import random
import sys

# main.py loads model/crnn.json via a path relative to the CWD at import time.
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.getcwd())

from PIL import Image  # noqa: E402
from main import extract_profile  # noqa: E402

failures = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + ("" if cond else f" — {detail}"))
    if not cond:
        failures.append(name)


def noisy_png_uri(w: int, h: int, space_form: bool = False) -> str:
    rng = random.Random(7)
    img = Image.frombytes("RGB", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 3)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    prefix = "data: image/png;base64," if space_form else "data:image/png;base64,"
    return prefix + base64.b64encode(buf.getvalue()).decode()


def page_with_photo(src: str) -> str:
    return ('<div><b>NAME :</b></div><div>TEST STUDENT</div>'
            '<div><b>Roll No :</b></div><div>2600000000</div>'
            f'<img src="{src}">')


# --- oversized photo (mirrors the friend's real page: >400KB, "data: image" space form) ---
big_src = noisy_png_uri(800, 1000, space_form=True)
assert len(big_src) > 400_000, f"fixture too small: {len(big_src)}"
p = extract_profile(page_with_photo(big_src))

check("oversized photo is not dropped", bool(p.get("photo")), f"profile={ {k: len(v) for k, v in p.items()} }")
if p.get("photo"):
    check("downscaled to a jpeg data uri", p["photo"].startswith("data:image/jpeg;base64,"),
          f"prefix: {p['photo'][:40]!r}")
    check("downscaled well below the old 400KB cap", len(p["photo"]) < 100_000,
          f"len={len(p['photo'])}")
    raw = base64.b64decode(p["photo"].split(",", 1)[1])
    img = Image.open(io.BytesIO(raw))
    check("fits within 256px", img.width <= 256 and img.height <= 256, f"size={img.width}x{img.height}")

# --- small photo still passes through unchanged ---
small_src = noisy_png_uri(40, 40)
p2 = extract_profile(page_with_photo(small_src))
check("small photo returned as-is", p2.get("photo") == small_src.replace("data: image", "data:image"),
      f"got prefix {p2.get('photo', '')[:40]!r} len={len(p2.get('photo', ''))}")

print("-" * 60)
if failures:
    print(f"SUMMARY: {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("SUMMARY: all passed")
sys.exit(0)
