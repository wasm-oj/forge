import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
N, Q, C = next(it), next(it), next(it)
pi = [0] * (N + 1)
pm = [0] * (N + 1)
bad = [False] * (N + 2)
for i in range(1, N + 1):
    k, x, m = next(it), next(it), next(it)
    bad[i] = k == 64 or x > C or (m != -1 and m < x)
    pi[i] = pi[i - 1]
    pm[i] = pm[i - 1]
    if not bad[i]:
        pi[i] += x
        pm[i] += C if m == -1 else min(C, m)
nxt = [N + 1] * (N + 2)
for i in range(N, 0, -1):
    nxt[i] = i if bad[i] else nxt[i + 1]
out = []
for _ in range(Q):
    l, r = next(it), next(it)
    out.append(
        f"REJECT {nxt[l]}"
        if nxt[l] <= r
        else f"ACCEPT {(pi[r]-pi[l-1])*65536} {(pm[r]-pm[l-1])*65536}"
    )
print("\n".join(out))
