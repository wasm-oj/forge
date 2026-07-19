#!/usr/bin/env python3
import re, sys

try:
    l = sys.stdin.read().splitlines()
    h = l[0].split()
    assert len(h) == 4 and all(re.fullmatch(r"0|[1-9][0-9]*", x) for x in h)
    n, C, A, R = map(int, h)
    assert (
        1 <= n <= 200000 and all(x <= 10**18 for x in (C, A, R)) and len(l) == n + 1
    )
    seen = set()
    total = 0
    for s in l[1:]:
        p = s.split()
        assert len(p) == 5
        z, pr, lu = map(int, p[:3])
        assert 1 <= z <= 10**18 and 0 <= pr <= 10**9 and 0 <= lu <= 10**18
        assert re.fullmatch(r"[a-z0-9]{1,20}", p[3]) and re.fullmatch(
            r"[a-z0-9]{1,20}", p[4]
        )
        assert tuple(p[3:]) not in seen
        seen.add(tuple(p[3:]))
        total += z
    assert total <= 9 * 10**18
except Exception:
    sys.exit(1)
