#!/usr/bin/env python3
import re, sys

try:
    a = sys.stdin.read().splitlines()
    assert a and re.fullmatch(r"[1-9][0-9]*", a[0])
    n = int(a[0])
    assert 1 <= n <= 200000 and len(a) == n + 1
    seen = set()
    for s in a[1:]:
        p = s.split(" ")
        if p[0] in ("A", "C"):
            assert (
                len(p) == 2
                and re.fullmatch(r"[1-9][0-9]*", p[1])
                and int(p[1]) <= 10**9
            )
            if p[0] == "A":
                assert p[1] not in seen
                seen.add(p[1])
        else:
            assert p == ["E"]
except Exception:
    sys.exit(1)
