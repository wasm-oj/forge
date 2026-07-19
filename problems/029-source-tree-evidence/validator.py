#!/usr/bin/env python3
import re, sys

pat = re.compile(r"[a-z0-9_.-]+(?:/[a-z0-9_.-]+)*")


def path(x):
    return (
        pat.fullmatch(x)
        and all(y not in (".", "..") for y in x.split("/"))
        and len(x) <= 120
    )


try:
    l = sys.stdin.read().splitlines()
    h = l[0].split()
    assert len(h) == 2
    n = int(h[0])
    E = h[1]
    assert 1 <= n <= 200000 and path(E) and len(l) == n + 1
    seen = set()
    for s in l[1:]:
        p = s.split()
        assert (
            " ".join(p) == s
            and p
            and p[0] in ("F", "L", "D")
            and len(p) == ({"F": 5, "L": 3, "D": 2}[p[0]])
            and path(p[1])
            and p[1] not in seen
        )
        seen.add(p[1])
        if p[0] == "F":
            assert (
                p[2] in ("0", "1")
                and re.fullmatch(r"0|[1-9][0-9]*", p[3])
                and int(p[3]) <= 10**18
                and re.fullmatch(r"[0-9a-f]{8}", p[4])
            )
        if p[0] == "L":
            assert re.fullmatch(r"[a-z0-9_./-]{1,120}", p[2])
except Exception:
    sys.exit(1)
