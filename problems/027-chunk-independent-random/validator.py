#!/usr/bin/env python3
import re, sys

try:
    l = sys.stdin.read().splitlines()
    assert len(l) == 2
    h = l[0].split()
    assert len(h) == 4 and all(re.fullmatch(r"0|[1-9][0-9]*", x) for x in h)
    a, b, S, Q = map(int, h)
    assert a < 2**64 and b < 2**64 and S <= 9 * 10**18 and 1 <= Q <= 200000
    p = l[1].split()
    assert len(p) == Q and all(re.fullmatch(r"[1-9][0-9]*", x) for x in p)
    assert sum(map(int, p)) <= 9 * 10**18
except Exception:
    sys.exit(1)
