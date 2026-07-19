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

    N, Q = u(1, 200000), u(1, 200000)
    total = 0
    for _ in range(N):
        if p >= len(t) or t[p] not in ("O", "E", "F"):
            fail()
        p += 1
        total += u(1, 10**12)
        if total > 9 * 10**18:
            fail()
    prev = -1
    for _ in range(Q):
        b = u(0, 9 * 10**18)
        if b < prev:
            fail()
        prev = b
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
