import re, sys


def fail():
    raise SystemExit(1)


try:
    t = sys.stdin.buffer.read().decode("ascii").split()
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

    N, Q, U = u(1, 200000), u(1, 200000), u(0, 9 * 10**18)
    seen = set()
    total = U
    length = 0
    max_length = 0
    for _ in range(N):
        if p >= len(t):
            fail()
        path = t[p]
        p += 1
        if (
            not 2 <= len(path) <= 200000
            or re.fullmatch(r"/[a-z0-9-]+(?:/[a-z0-9-]+)*", path) is None
            or path in seen
        ):
            fail()
        seen.add(path)
        length += len(path)
        max_length = max(max_length, len(path))
        total += u(0, 10**12)
        u(0, 10**12)
        if total > 9 * 10**18:
            fail()
    if length > 2000000 or Q * max_length > 2000000:
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
