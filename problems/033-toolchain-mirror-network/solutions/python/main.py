import sys

a = list(map(int, sys.stdin.read().split()))
n, m = a[:2]
e = [(a[i + 2], a[i] - 1, a[i + 1] - 1) for i in range(2, len(a), 3)]
e.sort()
p = list(range(n))
sz = [1] * n


def f(x):
    while p[x] != x:
        p[x] = p[p[x]]
        x = p[x]
    return x


cost = taken = 0
for w, u, v in e:
    u, v = f(u), f(v)
    if u == v:
        continue
    if sz[u] < sz[v]:
        u, v = v, u
    p[v] = u
    sz[u] += sz[v]
    cost += w
    taken += 1
    if taken == n - 1:
        break
print(f"COST {cost}" if taken == n - 1 else "IMPOSSIBLE")
