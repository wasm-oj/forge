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

    M, O, B, I = u(0, 200000), u(0, 200000), u(0, 9 * 10**18), u(0, 9 * 10**18)
    if not 1 <= M + O <= 200000:
        fail()
    paths = []
    segments = 0
    total = 0
    for j in range(M + O):
        k = u(1, 200000)
        segments += k
        path = tuple(u(1, 10**9) for _ in range(k))
        paths.append(path)
        if j < M:
            total += u(0, 9 * 10**18)
            if total > 9 * 10**18:
                fail()
    if segments > 200000 or p != len(t):
        fail()
    paths.sort()
    for a, b in zip(paths, paths[1:]):
        if len(a) <= len(b) and a == b[: len(a)]:
            fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
