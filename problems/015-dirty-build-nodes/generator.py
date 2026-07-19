import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 97 + index)
n = 8 + index % 13
all_edges = [
    (i, j) for i in range(1, n + 1) for j in range(i + 1, n + 1) if r.random() < 0.14
]
m = len(all_edges)
c = r.randrange(min(5, n) + 1)
changed = r.sample(range(1, n + 1), c)
print(n, m, c)
for e in all_edges:
    print(*e)
print(*changed)
