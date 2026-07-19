import sys

t = list(map(int, sys.stdin.buffer.read().split()))
N, C = t[:2]
a = list(zip(t[2::2], t[3::2]))
best = 0
for mask in range(1 << N):
    w = v = 0
    for i, (x, y) in enumerate(a):
        if mask >> i & 1:
            w += x
            v += y
    if w <= C:
        best = max(best, v)
print(best)
