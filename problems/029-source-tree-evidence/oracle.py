#!/usr/bin/env python3
import sys

l = sys.stdin.read().splitlines()
n, E = l[0].split()
a = []
for s in l[1:]:
    path = s.split()[1]
    if path != E and not path.startswith(E + "/"):
        i = 0
        while i < len(a) and a[i].split()[1] < path:
            i += 1
        a.insert(i, s)
sys.stdout.write(str(len(a)) + "\n" + ("\n".join(a) + "\n" if a else ""))
