import sys

U = 9_000_000_000_000_000_000


def main():
    ls = sys.stdin.read().splitlines()
    assert len(ls) >= 3
    h = ls[0].split()
    assert len(h) == 4
    n, d, q, c = map(int, h)
    assert (
        1 <= n <= 200000
        and 1 <= d <= 200000
        and 1 <= q <= 200000
        and 0 <= c <= U
        and len(ls) == q + 2
    )
    z = list(map(int, ls[1].split()))
    assert len(z) == d and all(0 <= x <= U for x in z) and sum(z) <= U
    gets = 0
    for line in ls[2:]:
        x = line.split()
        assert x and x[0] in ("P", "G")
        if x[0] == "P":
            assert len(x) == 3 and 1 <= int(x[1]) <= n and 1 <= int(x[2]) <= d
        else:
            assert len(x) == 2 and 1 <= int(x[1]) <= n
            gets += 1
    assert gets > 0


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
