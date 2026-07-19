from collections import deque
import sys


MOD = 1_000_000_007
data = list(map(int, sys.stdin.buffer.read().split()))
n, m = data[:2]
duration = data[2 : 2 + n]
graph = [[] for _ in range(n)]
indegree = [0] * n
outdegree = [0] * n
offset = 2 + n
for index in range(m):
    u = data[offset + 2 * index] - 1
    v = data[offset + 2 * index + 1] - 1
    graph[u].append(v)
    indegree[v] += 1
    outdegree[u] += 1

best = [0] * n
ways = [0] * n
queue = deque()
for node in range(n):
    if indegree[node] == 0:
        best[node] = duration[node]
        ways[node] = 1
        queue.append(node)

while queue:
    node = queue.popleft()
    for target in graph[node]:
        candidate = best[node] + duration[target]
        if candidate > best[target]:
            best[target] = candidate
            ways[target] = ways[node]
        elif candidate == best[target]:
            ways[target] = (ways[target] + ways[node]) % MOD
        indegree[target] -= 1
        if indegree[target] == 0:
            queue.append(target)

answer = -1
count = 0
for node in range(n):
    if outdegree[node] != 0:
        continue
    if best[node] > answer:
        answer, count = best[node], ways[node]
    elif best[node] == answer:
        count = (count + ways[node]) % MOD
print(answer, count)
