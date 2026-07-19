import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
G, C = next(it), next(it)
groups = []
for _ in range(G):
    k = next(it)
    groups.append([(next(it), next(it)) for _ in range(k)])
best = 0


def dfs(g, time, value):
    global best
    if time > C:
        return
    if g == G:
        best = max(best, value)
        return
    dfs(g + 1, time, value)
    for w, v in groups[g]:
        dfs(g + 1, time + w, value + v)


dfs(0, 0, 0)
print(best)
