import re, sys


def fail():
    raise SystemExit(1)


try:
    data = sys.stdin.buffer.read().decode("utf-8")
    if not data or "\x00" in data:
        fail()
    t = data.split()
    p = 0

    def ui(lo, hi):
        nonlocal_dummy = None
        global p
        if p >= len(t) or re.fullmatch(r"0|[1-9][0-9]*", t[p]) is None:
            fail()
        v = int(t[p])
        p += 1
        if not lo <= v <= hi:
            fail()
        return v

    K, W, R, Q = ui(1, 200000), ui(0, 200000), ui(1, 200000), ui(1, 200000)
    if W > K:
        fail()
    seen = set()
    weights = [1000] * (K + 1)
    for _ in range(W):
        i, w = ui(1, K), ui(1, 10**6)
        if i in seen:
            fail()
        seen.add(i)
        weights[i] = w
    total_c = total_n = 0
    for _ in range(R):
        i, c = ui(1, K), ui(1, 10**12)
        total_n += c
        total_c += c * weights[i]
        if total_n > 9 * 10**18 or total_c > 9 * 10**18:
            fail()
    for _ in range(Q):
        ui(0, 9 * 10**18)
    if p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
