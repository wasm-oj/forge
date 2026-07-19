import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 10007 + index)
l = 3 + index % 5
rr = 3 + (index // 2) % 5
edges = [(u, v) for u in range(1, l + 1) for v in range(1, rr + 1) if r.random() < 0.35]
print(l, rr, len(edges))
for e in edges:
    print(*e)
