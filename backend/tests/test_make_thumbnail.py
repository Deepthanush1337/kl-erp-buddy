"""
Offline unit tests for main.make_thumbnail() — downscales a base64 data-URI
avatar to a small JPEG data URI for storage in Supabase / admin-page use.

No network needed. Run from anywhere:
    backend/.venv/Scripts/python.exe backend/tests/test_make_thumbnail.py
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
from main import make_thumbnail  # noqa: E402

failures = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + ("" if cond else f" — {detail}"))
    if not cond:
        failures.append(name)


def big_photo_data_uri(w: int = 500, h: int = 700) -> str:
    # Noise, not a solid colour — solid PNGs compress to nothing and don't
    # resemble real photos.
    rng = random.Random(42)
    img = Image.frombytes("RGB", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 3)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


src = big_photo_data_uri()
out = make_thumbnail(src)

check("returns a jpeg data uri", out.startswith("data:image/jpeg;base64,"), f"prefix: {out[:40]!r}")

if out:
    raw = base64.b64decode(out.split(",", 1)[1])
    img = Image.open(io.BytesIO(raw))
    check("decodes to a valid JPEG", img.format == "JPEG", f"format={img.format!r}")
    check("scaled down to <=64px on both axes", img.width <= 64 and img.height <= 64,
          f"size={img.width}x{img.height}")
    check("aspect ratio preserved (500x700 -> 46x64)", (img.width, img.height) == (46, 64),
          f"size={img.width}x{img.height}")
    check("much smaller than the source", len(out) < len(src) // 4,
          f"{len(out)} vs {len(src)}")

check("empty string in -> empty string out", make_thumbnail("") == "")
check("garbage in -> empty string out", make_thumbnail("data:image/png;base64,!!!notbase64!!!") == "")
check("non-image data in -> empty string out",
      make_thumbnail("data:image/png;base64," + base64.b64encode(b"hello world").decode()) == "")

print("-" * 60)
if failures:
    print(f"SUMMARY: {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("SUMMARY: all passed")
sys.exit(0)
