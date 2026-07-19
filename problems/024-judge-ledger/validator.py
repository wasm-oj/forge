#!/usr/bin/env python3
import re, sys

try:
    l = sys.stdin.read().splitlines()
    h = l[0].split()
    assert len(h) == 2 and all(re.fullmatch(r"[1-9][0-9]*", x) for x in h)
    n, q = map(int, h)
    assert 1 <= n <= 200000 and 1 <= q <= 200000 and len(l) == 1 + n + q
    sc = st = 0
    for s in l[1 : n + 1]:
        p = s.split()
        assert len(p) == 5
        a = list(map(int, p))
        assert 0 <= a[0] <= 3
        assert all(x == -1 or 0 <= x <= 10**12 for x in a[1:])
        sc += max(0, a[1])
        st += max(0, a[2])
    assert sc <= 9 * 10**18 and st <= 9 * 10**18
    for s in l[n + 1 :]:
        p = s.split()
        assert len(p) == 3
        a, b, f = map(int, p)
        assert 1 <= a <= b <= n and f in (0, 1)
except Exception:
    sys.exit(1)
