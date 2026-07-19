import sys

a = list(map(int, sys.stdin.read().split()))
l, r, m = a[:3]
edges = [(a[i] - 1, a[i + 1] - 1) for i in range(3, len(a), 2)]
for k in range(l + r + 1):
    for mask in range(1 << (l + r)):
        if mask.bit_count() == k and all(
            mask >> u & 1 or mask >> (l + v) & 1 for u, v in edges
        ):
            print(k)
            raise SystemExit
