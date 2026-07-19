import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 65537 + index)
n = 10 + index % 15
h = 8 + index % 12
edges = [(s, x) for s in range(1, n + 1) for x in range(1, h + 1) if r.random() < 0.22]
q = 5 + index % 7
print(n, h, len(edges), q)
for e in edges:
    print(*e)
for _ in range(q):
    k = r.randrange(min(5, h) + 1)
    print(k, *r.sample(range(1, h + 1), k))
