import sys


def main():
    a = list(map(int, sys.stdin.read().split()))
    assert len(a) >= 4
    n, m, s, t = a[:4]
    assert 1 <= n <= 500 and 0 <= m <= 5000 and 1 <= s <= n and 1 <= t <= n
    assert len(a) == 4 + n + s + t + 2 * m
    p = 4
    c = a[p : p + n]
    p += n
    assert all(0 <= x <= 10**12 for x in c) and sum(c) <= 8 * 10**18
    e = a[p : p + s]
    p += s
    d = a[p : p + t]
    p += t
    assert (
        len(e) == len(set(e))
        and len(d) == len(set(d))
        and all(1 <= x <= n for x in e + d)
    )
    seen = set()
    for _ in range(m):
        u, v = a[p : p + 2]
        p += 2
        assert 1 <= u <= n and 1 <= v <= n and u != v and (u, v) not in seen
        seen.add((u, v))


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
