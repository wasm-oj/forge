import re, sys

U = 9_000_000_000_000_000_000


def main():
    ls = sys.stdin.read().splitlines()
    assert ls
    h = ls[0].split()
    assert len(h) == 2
    n = int(h[0])
    b = int(h[1])
    assert 1 <= n <= 300000 and 1 <= b <= U and len(ls) == n + 1
    for x in ls[1:]:
        p = x.split()
        assert len(p) == 2 and re.fullmatch(r"[a-z0-9-]{1,20}", p[0])
        s = int(p[1])
        assert str(s) == p[1] and 0 <= s <= 12


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
