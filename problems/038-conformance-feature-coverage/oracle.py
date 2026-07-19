import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
F, N, B = next(it), next(it), next(it)
a = []
for _ in range(N):
    c, k = next(it), next(it)
    m = 0
    for _ in range(k):
        m |= 1 << (next(it) - 1)
    a.append((c, m))
best = 0
for s in range(1 << N):
    c = m = 0
    for i, (x, y) in enumerate(a):
        if s >> i & 1:
            c += x
            m |= y
    if c <= B:
        best = max(best, m.bit_count())
print(best)
