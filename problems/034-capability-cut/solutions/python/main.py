import collections, sys

sys.setrecursionlimit(10000)
a = list(map(int, sys.stdin.read().split()))
n, m, sn, tn = a[:4]
p = 4
cost = a[p : p + n]
p += n
entries = [x - 1 for x in a[p : p + sn]]
p += sn
danger = [x - 1 for x in a[p : p + tn]]
p += tn
V = 2 * n + 2
S = 2 * n
T = S + 1
g = [[] for _ in range(V)]


def add(u, v, c):
    g[u].append([v, len(g[v]), c])
    g[v].append([u, len(g[u]) - 1, 0])


INF = sum(cost) + 1
for i, c in enumerate(cost):
    add(2 * i, 2 * i + 1, c)
for _ in range(m):
    u, v = a[p] - 1, a[p + 1] - 1
    p += 2
    add(2 * u + 1, 2 * v, INF)
for x in entries:
    add(S, 2 * x, INF)
for x in danger:
    add(2 * x + 1, T, INF)
flow = 0
while True:
    level = [-1] * V
    level[S] = 0
    q = collections.deque([S])
    while q:
        u = q.popleft()
        for v, _, c in g[u]:
            if c and level[v] < 0:
                level[v] = level[u] + 1
                q.append(v)
    if level[T] < 0:
        break
    it = [0] * V

    def dfs(u, f):
        if u == T:
            return f
        while it[u] < len(g[u]):
            e = g[u][it[u]]
            if e[2] and level[e[0]] == level[u] + 1:
                z = dfs(e[0], min(f, e[2]))
                if z:
                    e[2] -= z
                    g[e[0]][e[1]][2] += z
                    return z
            it[u] += 1
        return 0

    while True:
        z = dfs(S, INF)
        if not z:
            break
        flow += z
print("COST", flow)
