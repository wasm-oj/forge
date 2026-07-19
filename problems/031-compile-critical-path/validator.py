import sys


def fail(message: str) -> None:
    raise SystemExit(message)


tokens = sys.stdin.buffer.read().split()
try:
    values = list(map(int, tokens))
except ValueError:
    fail("input contains a non-integer token")
if len(values) < 2:
    fail("missing N and M")
n, m = values[0], values[1]
if not 1 <= n <= 200_000 or not 0 <= m <= 400_000:
    fail("N or M is outside its range")
if len(values) != 2 + n + 2 * m:
    fail("unexpected token count")
durations = values[2 : 2 + n]
if (
    any(value < 1 or value > 10**9 for value in durations)
    or sum(durations) > 9 * 10**18
):
    fail("invalid duration")
edges: list[list[int]] = [[] for _ in range(n)]
indegree = [0] * n
seen: set[tuple[int, int]] = set()
offset = 2 + n
for index in range(m):
    u, v = values[offset + 2 * index] - 1, values[offset + 2 * index + 1] - 1
    if not 0 <= u < n or not 0 <= v < n or u == v or (u, v) in seen:
        fail("invalid or duplicate edge")
    seen.add((u, v))
    edges[u].append(v)
    indegree[v] += 1
queue = [node for node, degree in enumerate(indegree) if degree == 0]
head = 0
while head < len(queue):
    node = queue[head]
    head += 1
    for target in edges[node]:
        indegree[target] -= 1
        if indegree[target] == 0:
            queue.append(target)
if len(queue) != n:
    fail("graph is not acyclic")
