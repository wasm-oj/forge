import sys

a = list(map(int, sys.stdin.read().split()))
n, m = a[:2]
reach = [[False] * n for _ in range(n)]
selfloop = [False] * n
for i in range(n):
    reach[i][i] = True
for i in range(2, len(a), 2):
    u, v = a[i] - 1, a[i + 1] - 1
    reach[u][v] = True
    selfloop[u] |= u == v
for k in range(n):
    for i in range(n):
        if reach[i][k]:
            for j in range(n):
                reach[i][j] |= reach[k][j]
comp = [-1] * n
groups = []
for i in range(n):
    if comp[i] >= 0:
        continue
    g = [j for j in range(n) if reach[i][j] and reach[j][i]]
    cid = len(groups)
    for j in g:
        comp[j] = cid
    groups.append(g)
indeg = [False] * len(groups)
for i in range(2, len(a), 2):
    u, v = a[i] - 1, a[i + 1] - 1
    indeg[comp[v]] |= comp[u] != comp[v]
cyc = [g for g in groups if len(g) > 1 or selfloop[g[0]]]
cyc.sort(key=lambda g: g[0])
print(len(cyc), sum(not x for x in indeg))
for g in cyc:
    print(len(g), *(x + 1 for x in g))
