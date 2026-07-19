#!/usr/bin/env python3
import re, sys


def fail():
    raise ValueError


try:
    lines = sys.stdin.read().splitlines()
    if not lines or not re.fullmatch(r"[1-9][0-9]*", lines[0]):
        fail()
    n = int(lines[0])
    if not 1 <= n <= 200000 or len(lines) != n + 1:
        fail()
    total = 0
    for s in lines[1:]:
        p = s.split(" ")
        if p[0] in ("B", "F"):
            if len(p) != 2 or not re.fullmatch(r"[a-z]{1,20}", p[1]):
                fail()
            total += len(p[1])
        elif p[0] == "S":
            if p != ["S"]:
                fail()
        elif p[0] == "D":
            if (
                len(p) != 2
                or not re.fullmatch(r"[1-9][0-9]*", p[1])
                or int(p[1]) > n + 1
            ):
                fail()
        else:
            fail()
    if total > 2000000:
        fail()
except Exception:
    sys.exit(1)
