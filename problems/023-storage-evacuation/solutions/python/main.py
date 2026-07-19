import sys

it = iter(sys.stdin.buffer.read().split())
n = int(next(it))
C = int(next(it))
A = int(next(it))
R = int(next(it))
v = []
for _ in range(n):
    v.append((int(next(it)), int(next(it)), int(next(it)), next(it), next(it)))
need = max(0, sum(x[0] for x in v) - C, R - A)
if need > sum(x[0] for x in v):
    print("IMPOSSIBLE")
else:
    v.sort(key=lambda x: (x[1], x[2], x[3], x[4]))
    freed = k = 0
    while freed < need:
        freed += v[k][0]
        k += 1
    print(k, freed)
    for x in v[:k]:
        print(x[3].decode(), x[4].decode())
