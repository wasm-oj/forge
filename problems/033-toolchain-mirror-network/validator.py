import sys


def main():
    a = list(map(int, sys.stdin.read().split()))
    assert len(a) >= 2
    n, m = a[:2]
    assert 1 <= n <= 200000 and 0 <= m <= 400000 and len(a) == 2 + 3 * m
    p = 2
    for _ in range(m):
        u, v, w = a[p : p + 3]
        p += 3
        assert 1 <= u <= n and 1 <= v <= n and u != v and 0 <= w <= 10**12


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
