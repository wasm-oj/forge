import collections, itertools, sys

a = list(map(int, sys.stdin.read().split()))
n, m, s, t = a[:4]
p = 4
c = a[p : p + n]
p += n
entries = [x - 1 for x in a[p : p + s]]
p += s
danger = {x - 1 for x in a[p : p + t]}
p += t
g = [[] for _ in range(n)]
for _ in range(m):
    u, v = a[p] - 1, a[p + 1] - 1
    p += 2
    g[u].append(v)
best = sum(c)
for mask in range(1 << n):
    z = sum(c[i] for i in range(n) if mask >> i & 1)
    if z >= best:
        continue
    q = collections.deque(x for x in entries if not (mask >> x & 1))
    seen = set(q)
    bad = False
    while q:
        u = q.popleft()
        if u in danger:
            bad = True
            break
        for v in g[u]:
            if not (mask >> v & 1) and v not in seen:
                seen.add(v)
                q.append(v)
    if not bad:
        best = z
print("COST", best)
