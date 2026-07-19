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

    F, N, B = u(1, 200000), u(1, 200000), u(0, 9 * 10**18)
    size = [0] * (F + 1)
    cur = [0] * (F + 1)
    used = 0
    for _ in range(N):
        if p >= len(t):
            fail()
        op = t[p]
        p += 1
        x = u(1, F)
        v = u(0, 9 * 10**18)
        if op == "SEEK":
            cur[x] = v
        elif op == "WRITE":
            if cur[x] + v > 9 * 10**18:
                fail()
            new = size[x] if v == 0 else max(size[x], cur[x] + v)
            if used - size[x] + new <= B:
                used += new - size[x]
                size[x] = new
                cur[x] += v
        elif op == "TRUNCATE":
            if used - size[x] + v <= B:
                used += v - size[x]
                size[x] = v
        else:
            fail()
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
