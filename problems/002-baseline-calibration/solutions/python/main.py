import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
P, S, N, Q = next(it), next(it), next(it), next(it)
c = [0] * (P + 1)
lo = [10**19] * (P + 1)
hi = [0] * (P + 1)
for _ in range(N):
    p = next(it)
    next(it)
    v = next(it)
    c[p] += 1
    lo[p] = min(lo[p], v)
    hi[p] = max(hi[p], v)
out = []
for _ in range(Q):
    p, raw = next(it), next(it)
    out.append(
        "INVALID" if c[p] != S or lo[p] != hi[p] else f"{lo[p]} {max(0,raw-lo[p])}"
    )
print("\n".join(out))
