import re, sys


def fail():
    raise SystemExit(1)


try:
    t = sys.stdin.buffer.read().decode("utf-8").split()
    p = 0

    def u(a, b):
        global p
        if p >= len(t) or re.fullmatch(r"0|[1-9][0-9]*", t[p]) is None:
            fail()
        v = int(t[p])
        p += 1
        if not a <= v <= b:
            fail()
        return v

    N, B, I = u(1, 100), u(0, 3000), u(0, 30)
    total = 0
    for _ in range(N):
        u(0, 3000)
        u(1, 30)
        total += u(0, 10**12)
    if total > 9 * 10**18 or p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
