import re, sys

P = re.compile(r"[a-z0-9._/-]+$")
T = re.compile(r"[a-z0-9._-]+$")
D = re.compile(r"[0-9a-f]{8,64}$")


def path_ok(p):
    return (
        len(p) <= 100
        and not p.startswith("/")
        and not p.endswith("/")
        and P.fullmatch(p)
        and all(x not in ("", ".", "..") for x in p.split("/"))
    )


def main():
    ls = sys.stdin.read().splitlines()
    assert ls and len("\n".join(ls).encode()) <= 4_000_000
    h = ls[0].split()
    assert len(h) == 2 and all(
        x.isdigit() and (x == "0" or not x.startswith("0")) for x in h
    )
    n, q = map(int, h)
    assert 1 <= n <= 200000 and 1 <= q <= 200000 and len(ls) == 1 + n + q
    paths = set()
    for line in ls[1 : n + 1]:
        x = line.split()
        assert len(x) == 2 and path_ok(x[0]) and D.fullmatch(x[1]) and x[0] not in paths
        paths.add(x[0])
    total = 0
    for line in ls[n + 1 :]:
        x = line.split()
        assert len(x) >= 5 and all(T.fullmatch(v) for v in x[:4])
        assert x[4].isdigit() and (x[4] == "0" or not x[4].startswith("0"))
        k = int(x[4])
        assert len(x) == 5 + k
        ids = list(map(int, x[5:]))
        assert all(1 <= v <= n for v in ids) and len(ids) == len(set(ids))
        total += k
    assert total <= 400000


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
