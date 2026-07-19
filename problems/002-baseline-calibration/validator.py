import re, sys


def fail():
    raise SystemExit(1)


try:
    d = sys.stdin.buffer.read().decode("utf-8")
    t = d.split()
    p = 0

    def u(lo, hi):
        global p
        if p >= len(t) or re.fullmatch(r"0|[1-9][0-9]*", t[p]) is None:
            fail()
        v = int(t[p])
        p += 1
        if not lo <= v <= hi:
            fail()
        return v

    P, S, N, Q = u(1, 200000), u(1, 200000), u(0, 200000), u(1, 200000)
    seen = set()
    for _ in range(N):
        a, b = u(1, P), u(1, S)
        u(0, 9 * 10**18)
        if (a, b) in seen:
            fail()
        seen.add((a, b))
    for _ in range(Q):
        u(1, P)
        u(0, 9 * 10**18)
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
