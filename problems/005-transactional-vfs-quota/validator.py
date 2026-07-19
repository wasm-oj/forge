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

    P, N, B, I = u(1, 200000), u(1, 200000), u(0, 9 * 10**18), u(0, 200000)
    if I > P:
        fail()
    for _ in range(N):
        if p >= len(t):
            fail()
        op = t[p]
        p += 1
        if op in ("CREATE", "UNLINK"):
            u(1, P)
        elif op == "TRUNCATE":
            u(1, P)
            u(0, 9 * 10**18)
        elif op == "WRITE":
            u(1, P)
            a = u(0, 9 * 10**18)
            b = u(0, 9 * 10**18)
            if a + b > 9 * 10**18:
                fail()
        else:
            fail()
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
