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

    F, N, B = u(1, 20), u(1, 25), u(0, 10**12)
    for _ in range(N):
        u(0, 10**9)
        k = u(0, F)
        seen = set()
        for _ in range(k):
            x = u(1, F)
            if x in seen:
                fail()
            seen.add(x)
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
