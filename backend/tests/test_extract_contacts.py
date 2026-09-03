"""
Offline unit tests for main.extract_contacts() — the parser that pulls student
and parent mobile numbers out of the ERP Contact Information tab
(studentinfo/studentcontactnoinfo/tab_index_personal).

The fixtures mirror the REAL tab markup observed against the live ERP: a grid
of rows `# | Contact Type | Contact Relation | Phone Number`, e.g.
`3 | mobile | self | 8919090871`.

No network, no ERP creds needed. Run from anywhere:
    backend/.venv/Scripts/python.exe backend/tests/test_extract_contacts.py
Exit: 0 = all passed, 1 = at least one failure.
"""

import os
import sys

# main.py loads model/crnn.json via a path relative to the CWD at import time.
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.getcwd())

from main import extract_contacts  # noqa: E402

failures = []


def check(name: str, got: dict, want: dict) -> None:
    ok = got == want
    print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        print(f"       got:  {got!r}")
        print(f"       want: {want!r}")
        failures.append(name)


def grid(rows: list[tuple[str, str, str]]) -> str:
    body = "".join(
        f"<tr><td>{i}</td><td>{ctype}</td><td>{rel}</td><td>{num}</td></tr>"
        for i, (ctype, rel, num) in enumerate(rows, 1)
    )
    return f"""
    <html><body>
    <table><thead><tr><th>#</th><th>Contact Type</th><th>Contact Relation</th><th>Phone Number</th></tr></thead>
    <tbody>{body}</tbody></table>
    </body></html>
    """


# The exact rows seen on the owner's account (numbers anonymised here).
check("real grid: self + father + mother (communication ignored)",
      extract_contacts(grid([
          ("mobile", "father", "9032370750"),
          ("mobile", "mother", "9390607068"),
          ("mobile", "self", "8919090871"),
          ("mobile", "communication", "9390607068"),
      ])),
      {"phone": "8919090871", "parent_phone": "9032370750, 9390607068"})

check("no self row -> communication number becomes the student phone",
      extract_contacts(grid([
          ("mobile", "father", "9032370750"),
          ("mobile", "communication", "8919090871"),
      ])),
      {"phone": "8919090871", "parent_phone": "9032370750"})

check("duplicate parent numbers are deduped",
      extract_contacts(grid([
          ("mobile", "father", "9032370750"),
          ("mobile", "mother", "9032370750"),
          ("mobile", "self", "8919090871"),
      ])),
      {"phone": "8919090871", "parent_phone": "9032370750"})

check("+91 / spaced numbers normalised to 10 digits",
      extract_contacts(grid([
          ("mobile", "father", "+91 90323 70750"),
          ("mobile", "self", "91-8919090871"),
      ])),
      {"phone": "8919090871", "parent_phone": "9032370750"})

check("headers only (no data rows) -> empty dict",
      extract_contacts(grid([])),
      {})

check("non-mobile rows (email etc.) are ignored",
      extract_contacts(grid([
          ("email", "self", "student@example.com"),
          ("mobile", "self", "8919090871"),
      ])),
      {"phone": "8919090871"})

print("-" * 60)
if failures:
    print(f"SUMMARY: {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("SUMMARY: all passed")
sys.exit(0)
