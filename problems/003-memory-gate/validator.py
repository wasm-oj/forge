import re, sys


def fail():
    raise SystemExit(1)


try:
    t = sys.stdin.buffer.read().decode("utf-8").split()
    p = 0

    def tok():
        global p
        if p >= len(t):
            fail()
        x = t[p]
        p += 1
        return x

    def u(a, b):
        x = tok()
        if re.fullmatch(r"0|[1-9][0-9]*", x) is None:
            fail()
        v = int(x)
        if not a <= v <= b:
            fail()
        return v

    N, Q, C = u(1, 200000), u(1, 200000), u(1, 10**12)
    total = 0
    for _ in range(N):
        k = u(32, 64)
        if k not in (32, 64):
            fail()
        ini = u(0, 10**12)
        m = tok()
        if m == "-1":
            mx = -1
        elif re.fullmatch(r"0|[1-9][0-9]*", m):
            mx = int(m)
        else:
            fail()
        if mx > 10**12:
            fail()
        if k == 32 and ini <= C and (mx == -1 or mx >= ini):
            total += C if mx == -1 else min(C, mx)
    if total > 137329101562500:
        fail()
    for _ in range(Q):
        l, r = u(1, N), u(1, N)
        if l > r:
            fail()
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
