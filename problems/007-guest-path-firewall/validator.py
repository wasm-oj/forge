import re, sys


def fail():
    raise SystemExit(1)


try:
    data = sys.stdin.buffer.read().decode("ascii")
    lines = data.splitlines()
    if not lines or re.fullmatch(r"[1-9][0-9]*", lines[0]) is None:
        fail()
    n = int(lines[0])
    if not 1 <= n <= 200000 or len(lines) != n + 1:
        fail()
    total = 0
    for s in lines[1:]:
        if (
            not 1 <= len(s) <= 200000
            or not s.startswith("/")
            or re.fullmatch(r"[a-z0-9_./-]+", s) is None
        ):
            fail()
        total += len(s)
    if total > 2000000:
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
