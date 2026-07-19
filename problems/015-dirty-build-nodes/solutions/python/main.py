import sys, collections

a = list(map(int, sys.stdin.read().split()))
n, m, c = a[:3]
g = [[] for _ in range(n)]
p = 3
for _ in range(m):
    u, v = a[p] - 1, a[p + 1] - 1
    p += 2
    g[u].append(v)
dirty = [False] * n
q = collections.deque()
for x in a[p : p + c]:
    dirty[x - 1] = True
    q.append(x - 1)
while q:
    u = q.popleft()
    for v in g[u]:
        if not dirty[v]:
            dirty[v] = True
            q.append(v)
ids = [str(i + 1) for i, x in enumerate(dirty) if x]
print(len(ids))
print(" ".join(ids))
