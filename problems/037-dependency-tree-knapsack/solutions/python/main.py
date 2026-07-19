import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
N, C = next(it), next(it)
ch = [[] for _ in range(N + 1)]
size = [0] * (N + 1)
value = [0] * (N + 1)
for i in range(1, N + 1):
    p, size[i], value[i] = next(it), next(it), next(it)
    ch[p].append(i)
order = []
after = []


def dfs(u):
    pos = len(order)
    order.append(u)
    after.append(0)
    for v in ch[u]:
        dfs(v)
    after[pos] = len(order)


for u in ch[0]:
    dfs(u)
dp = [[0] * (C + 1) for _ in range(N + 1)]
for i in range(N - 1, -1, -1):
    u = order[i]
    skip = dp[after[i]]
    take = dp[i + 1]
    row = dp[i]
    w = size[u]
    v = value[u]
    for c in range(C + 1):
        row[c] = max(skip[c], v + take[c - w] if c >= w else 0)
print(dp[0][C])
