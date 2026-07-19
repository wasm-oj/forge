import sys


MOD = 1_000_000_007
data = list(map(int, sys.stdin.buffer.read().split()))
n, m = data[:2]
duration = data[2 : 2 + n]
graph = [[] for _ in range(n)]
indegree = [0] * n
outdegree = [0] * n
offset = 2 + n
for i in range(m):
    u, v = data[offset + 2 * i] - 1, data[offset + 2 * i + 1] - 1
    graph[u].append(v)
    indegree[v] += 1
    outdegree[u] += 1

best = -1
ways = 0


def enumerate_paths(node: int, total: int) -> None:
    global best, ways
    total += duration[node]
    if outdegree[node] == 0:
        if total > best:
            best, ways = total, 1
        elif total == best:
            ways = (ways + 1) % MOD
        return
    for target in graph[node]:
        enumerate_paths(target, total)


for source in range(n):
    if indegree[source] == 0:
        enumerate_paths(source, 0)
print(best, ways % MOD)
