#!/usr/bin/env python3
import re, sys

try:
    l = sys.stdin.read().splitlines()
    h = l[0].split()
    assert len(h) == 2 and all(re.fullmatch(r"0|[1-9][0-9]*", x) for x in h)
    b, r = map(int, h)
    assert 0 <= b <= 200000 and 0 <= r <= 200000 and b + r >= 1 and len(l) == 1 + b + r
    blobs = []
    for s in l[1 : 1 + b]:
        p = s.split()
        assert len(p) == 3 and re.fullmatch(r"[0-9a-f]{8}", p[0])
        assert all(
            re.fullmatch(r"0|[1-9][0-9]*", x) and int(x) <= 10**18 for x in p[1:]
        )
        blobs.append((p[0], int(p[1]), int(p[2])))
    refs = l[1 + b :]
    assert all(re.fullmatch(r"[0-9a-f]{8}", s) for s in refs)

    canonical = (
        all(blobs[i - 1][0] < blobs[i][0] for i in range(1, b))
        and all(declared == actual for _, declared, actual in blobs)
        and all(refs[i - 1] < refs[i] for i in range(1, r))
    )
    if canonical:
        at = 0
        total = 0
        for ref in refs:
            while at < b and blobs[at][0] < ref:
                at += 1
            if at == b or blobs[at][0] != ref:
                canonical = False
                break
            total += blobs[at][2]
            at += 1
        if canonical:
            assert total <= 9 * 10**18
except Exception:
    sys.exit(1)
