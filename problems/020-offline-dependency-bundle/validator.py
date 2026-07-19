import re, sys

N = re.compile(r"[a-z0-9-]{1,30}$")
D = re.compile(r"[0-9a-f]{8,64}$")
U = 9_000_000_000_000_000_000


def main():
    ls = sys.stdin.read().splitlines()
    assert ls
    h = ls[0].split()
    assert len(h) == 2
    n, m = map(int, h)
    assert 1 <= n <= 200000 and 1 <= m <= 200000 and len(ls) == 1 + n + m
    names = set()
    total = 0
    for line in ls[1 : n + 1]:
        x = line.split()
        assert (
            len(x) == 3
            and N.fullmatch(x[0])
            and D.fullmatch(x[1])
            and x[0] not in names
        )
        names.add(x[0])
        z = int(x[2])
        assert str(z) == x[2] and 0 <= z <= U
        total += z
    assert total <= U
    for line in ls[n + 1 :]:
        x = line.split()
        assert len(x) == 2 and D.fullmatch(x[0])
        z = int(x[1])
        assert str(z) == x[1] and 0 <= z <= U


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
