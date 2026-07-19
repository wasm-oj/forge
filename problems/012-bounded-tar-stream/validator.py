import re, sys

U = 9_000_000_000_000_000_000


def main():
    ls = sys.stdin.read().splitlines()
    assert ls
    h = ls[0].split()
    assert len(h) == 3 and all(re.fullmatch(r"0|[1-9][0-9]*", x) for x in h)
    n, f, b = map(int, h)
    assert 1 <= n <= 200000 and 0 <= f <= n and b <= U and len(ls) == n + 1
    end = 0
    for line in ls[1:]:
        p = line.split()
        assert len(p) == 6
        o, t, name, z, c, d = p
        assert (
            re.fullmatch(r"[A-Z]", t)
            and 1 <= len(name) <= 200
            and all(33 <= ord(x) <= 126 for x in name)
        )
        assert all(re.fullmatch(r"0|[1-9][0-9]*", x) for x in (o, z, c, d))
        vals = list(map(int, (o, z, c, d)))
        assert all(x <= U for x in vals)
        end += 512 + ((vals[1] + 511) // 512) * 512
        assert end <= U


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
