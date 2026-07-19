import re, sys

R = re.compile(r"[a-z0-9-]{1,30}$")


def main():
    ls = sys.stdin.read().splitlines()
    assert ls
    h = ls[0].split()
    assert len(h) == 2
    n, m = map(int, h)
    assert 1 <= n <= 200000 and 0 <= m <= 400000 and len(ls) == 1 + n + m
    names = [x.strip() for x in ls[1 : n + 1]]
    assert all(R.fullmatch(x) for x in names) and len(names) == len(set(names))
    seen = set()
    for line in ls[n + 1 :]:
        x = line.split()
        assert (
            len(x) == 2
            and all(R.fullmatch(v) for v in x)
            and x[0] != x[1]
            and tuple(x) not in seen
        )
        seen.add(tuple(x))


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
