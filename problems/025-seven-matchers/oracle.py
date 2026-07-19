#!/usr/bin/env python3
import sys

l = sys.stdin.read().splitlines()
q = int(l[0])
at = 1
for _ in range(q):
    h = l[at].split()
    at += 1
    k = h[0]
    e = l[at].split()
    a = l[at + 1].split()
    at += 2
    ok = False
    if k == "EXACT":
        ok = "".join(e) == "".join(a)
    elif k == "LINES":
        while e and e[-1] == "#":
            e.pop()
        while a and a[-1] == "#":
            a.pop()
        ok = e == a
    elif k == "TOKENS":
        ok = e == a
    elif k == "FLOAT":
        ok = len(e) == len(a) and all(
            abs(int(x) - int(y)) <= int(h[3]) for x, y in zip(e, a)
        )
    elif k == "SET":
        ok = all(any(x == y for y in a) for x in e) and all(
            any(y == x for x in e) for y in a
        )
    else:
        used = [False] * len(a)
        ok = len(e) == len(a)
        for x in e:
            j = next((j for j, y in enumerate(a) if not used[j] and x == y), None)
            if j is None:
                ok = False
                break
            used[j] = True
    print("ACCEPT" if ok else "WRONG")
