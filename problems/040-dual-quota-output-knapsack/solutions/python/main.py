import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
N, B, I = next(it), next(it), next(it)
dp = [[0] * (B + 1) for _ in range(I + 1)]
for _ in range(N):
    b, e, v = next(it), next(it), next(it)
    for x in range(I, e - 1, -1):
        row, old = dp[x], dp[x - e]
        for y in range(B, b - 1, -1):
            row[y] = max(row[y], old[y - b] + v)
print(dp[I][B])
