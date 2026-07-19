import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
N, C = next(it), next(it)
dp = [0] * (C + 1)
for _ in range(N):
    w, v = next(it), next(it)
    for c in range(C, w - 1, -1):
        dp[c] = max(dp[c], dp[c - w] + v)
print(dp[C])
