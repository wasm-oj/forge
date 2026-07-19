#!/usr/bin/env python3
import re, sys

try:
    l = sys.stdin.read().splitlines()
    q = int(l[0])
    assert 1 <= q <= 20000
    at = 1
    cnt = chars = 0
    kinds = {"EXACT", "LINES", "TOKENS", "FLOAT", "SET", "MULTISET", "FILESET"}
    for _ in range(q):
        h = l[at].split()
        at += 1
        assert h[0] in kinds and len(h) == (4 if h[0] == "FLOAT" else 3)
        n, m = map(int, h[1:3])
        assert 0 <= n <= 200000 and 0 <= m <= 200000
        if h[0] == "FLOAT":
            assert re.fullmatch(r"0|[1-9][0-9]*", h[3]) and int(h[3]) <= 10**18
        e = l[at].split() if l[at] else []
        a = l[at + 1].split() if l[at + 1] else []
        at += 2
        assert len(e) == n and len(a) == m
        for side in (e, a):
            if h[0] == "FLOAT":
                assert all(
                    re.fullmatch(r"-?(0|[1-9][0-9]*)", x) and abs(int(x)) <= 10**18
                    for x in side
                )
            elif h[0] == "FILESET":
                paths = []
                for x in side:
                    assert re.fullmatch(r"[a-z0-9]{1,20}@[0-9a-f]{8}", x)
                    paths.append(x.split("@")[0])
                assert len(paths) == len(set(paths))
            else:
                assert all(re.fullmatch(r"[A-Za-z0-9_#@.\-]{1,30}", x) for x in side)
        cnt += n + m
        chars += sum(map(len, e + a))
    assert at == len(l) and cnt <= 200000 and chars <= 4000000
except Exception:
    sys.exit(1)
