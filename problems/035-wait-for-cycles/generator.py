import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 43 + index)
n = 5 + index % 5
edges = [(u, v) for u in range(1, n + 1) for v in range(1, n + 1) if r.random() < 0.14]
print(n, len(edges))
for e in edges:
    print(*e)
