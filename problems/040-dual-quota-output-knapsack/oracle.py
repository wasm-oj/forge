import sys

t = list(map(int, sys.stdin.buffer.read().split()))
N, B, I = t[:3]
a = list(zip(t[3::3], t[4::3], t[5::3]))
best = 0
for mask in range(1 << N):
    b = e = v = 0
    for i, (x, y, z) in enumerate(a):
        if mask >> i & 1:
            b += x
            e += y
            v += z
    if b <= B and e <= I:
        best = max(best, v)
print(best)
