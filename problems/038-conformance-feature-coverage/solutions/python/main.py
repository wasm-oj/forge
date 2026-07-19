import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
F, N, B = next(it), next(it), next(it)
S = 1 << F
inf = 10**30
dp = [inf] * S
dp[0] = 0
for _ in range(N):
    cost, k = next(it), next(it)
    m = 0
    for _ in range(k):
        m |= 1 << (next(it) - 1)
    ndp = dp[:]
    for s, v in enumerate(dp):
        if v != inf:
            q = s | m
            ndp[q] = min(ndp[q], v + cost)
    dp = ndp
print(max(s.bit_count() for s, v in enumerate(dp) if v <= B))
