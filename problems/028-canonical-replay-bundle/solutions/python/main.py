import sys

t = iter(sys.stdin.buffer.read().split())
n = int(next(t))
r = int(next(t))
a = [(next(t), int(next(t)), int(next(t))) for _ in range(n)]
q = [next(t) for _ in range(r)]
for i in range(1, n):
    if a[i][0] <= a[i - 1][0]:
        print("INVALID BLOB_ORDER", i + 1)
        raise SystemExit
for i, x in enumerate(a):
    if x[1] != x[2]:
        print("INVALID LENGTH", i + 1)
        raise SystemExit
for i in range(1, r):
    if q[i] <= q[i - 1]:
        print("INVALID REF_ORDER", i + 1)
        raise SystemExit
j = 0
for i, d in enumerate(q):
    while j < n and a[j][0] < d:
        j += 1
    if j == n or a[j][0] != d:
        print("INVALID MISSING", i + 1)
        raise SystemExit
    j += 1
j = total = 0
for d in q:
    while a[j][0] < d:
        j += 1
    total += a[j][2]
    j += 1
print("VALID", total)
