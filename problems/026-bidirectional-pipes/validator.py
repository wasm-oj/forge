#!/usr/bin/env python3
import re, sys

try:
    l = sys.stdin.read().splitlines()
    h = l[0].split()
    assert len(h) == 3
    C, na, nb = map(int, h)
    assert (
        1 <= C <= 10**18
        and 0 <= na <= 200000
        and 0 <= nb <= 200000
        and 1 <= na + nb <= 200000
        and len(l) == 1 + na + nb
    )
    for seg in (l[1 : 1 + na], l[1 + na :]):
        closed = False
        for s in seg:
            p = s.split()
            if p[0] in ("W", "R"):
                assert (
                    len(p) == 2
                    and re.fullmatch(r"[1-9][0-9]*", p[1])
                    and int(p[1]) <= C
                )
                if p[0] == "W":
                    assert not closed
            else:
                assert p == ["C"] and not closed
                closed = True
except Exception:
    sys.exit(1)
