import sys


def main():
    a = list(map(int, sys.stdin.read().split()))
    assert len(a) >= 4
    n, h, m, q = a[:4]
    assert 1 <= n <= 6000 and 1 <= h <= 6000 and 0 <= m <= 200000 and 1 <= q <= 20000
    p = 4
    seen = set()
    for _ in range(m):
        s, x = a[p : p + 2]
        p += 2
        assert 1 <= s <= n and 1 <= x <= h and (s, x) not in seen
        seen.add((s, x))
    total = 0
    for _ in range(q):
        assert p < len(a)
        k = a[p]
        p += 1
        assert 0 <= k <= h and p + k <= len(a)
        v = a[p : p + k]
        p += k
        assert len(v) == len(set(v)) and all(1 <= x <= h for x in v)
        total += k
    assert p == len(a) and total <= 50000


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
