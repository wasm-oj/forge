import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
N, C = next(it), next(it)
a = [(next(it), next(it), next(it)) for _ in range(N)]
best = 0
for mask in range(1 << N):
    ok = True
    w = v = 0
    for i, (p, s, x) in enumerate(a):
        if mask >> i & 1:
            if p and not (mask >> (p - 1) & 1):
                ok = False
                break
            w += s
            v += x
    if ok and w <= C:
        best = max(best, v)
print(best)
