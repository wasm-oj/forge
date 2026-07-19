#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 31 + index)
C = r.randint(1, 20)
na = 8 + index % 7
nb = 7 + (index * 3) % 8


def prog(n):
    out = []
    closed = False
    for i in range(n):
        t = r.randrange(5)
        if not closed and t == 0:
            out.append("C")
            closed = True
        elif not closed and t < 3:
            out.append(f"W {r.randint(1,C)}")
        else:
            out.append(f"R {r.randint(1,C)}")
    return out


a = prog(na)
b = prog(nb)
print(C, na, nb)
print(*a, sep="\n")
print(*b, sep="\n")
