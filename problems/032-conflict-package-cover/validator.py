import sys


def main():
    a = list(map(int, sys.stdin.read().split()))
    assert len(a) >= 3
    l, r, m = a[:3]
    assert (
        1 <= l <= 200000
        and 1 <= r <= 200000
        and 0 <= m <= 400000
        and len(a) == 3 + 2 * m
    )
    seen = set()
    p = 3
    for _ in range(m):
        u, v = a[p : p + 2]
        p += 2
        assert 1 <= u <= l and 1 <= v <= r and (u, v) not in seen
        seen.add((u, v))


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
