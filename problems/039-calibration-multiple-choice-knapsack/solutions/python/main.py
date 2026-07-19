import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
G, C = next(it), next(it)
dp = [0] * (C + 1)
for _ in range(G):
    k = next(it)
    a = [(next(it), next(it)) for _ in range(k)]
    ndp = dp[:]
    for w, v in a:
        for c in range(w, C + 1):
            ndp[c] = max(ndp[c], dp[c - w] + v)
    dp = ndp
print(dp[C])
