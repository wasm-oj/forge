import sys

a = list(map(int, sys.stdin.read().split()))
n, h, m, q = a[:4]
rev = [set() for _ in range(h)]
p = 4
for _ in range(m):
    s, x = a[p] - 1, a[p + 1] - 1
    p += 2
    rev[x].add(s)
for _ in range(q):
    k = a[p]
    p += 1
    hit = set()
    for x in a[p : p + k]:
        hit |= rev[x - 1]
    p += k
    print(len(hit))
