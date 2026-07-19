import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
seed, index = map(int, sys.argv[1:])
rng = random.Random((seed << 17) ^ index)
n = rng.randint(1, 10)
durations = [rng.randint(1, 20) for _ in range(n)]
edges = []
for u in range(n):
    for v in range(u + 1, n):
        if rng.random() < 0.28:
            edges.append((u + 1, v + 1))
print(n, len(edges))
print(*durations)
for edge in edges:
    print(*edge)
