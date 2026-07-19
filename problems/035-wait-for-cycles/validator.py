import sys


def main():
    a = list(map(int, sys.stdin.read().split()))
    assert len(a) >= 2
    n, m = a[:2]
    assert 1 <= n <= 200000 and 0 <= m <= 400000 and len(a) == 2 + 2 * m
    seen = set()
    p = 2
    for _ in range(m):
        u, v = a[p : p + 2]
        p += 2
        assert 1 <= u <= n and 1 <= v <= n and (u, v) not in seen
        seen.add((u, v))


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
