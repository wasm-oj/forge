#!/usr/bin/env python3
import sys

lines = sys.stdin.read().splitlines()[1:]
active = 0
q = []
terminal = set()
out = []
for s in lines:
    p = s.split()
    t = p[0]
    if t == "A":
        x = int(p[1])
        if active == 0:
            active = x
        else:
            q.append(x)
    elif t == "C":
        x = int(p[1])
        terminal.add(x)
        if active == x:
            active = 0
        else:
            try:
                q.remove(x)
            except ValueError:
                pass
    else:
        if active:
            terminal.add(active)
            active = 0
    if active == 0 and q:
        active = q.pop(0)
    out.append(f"{active} {len(q)}")
print("\n".join(out))
