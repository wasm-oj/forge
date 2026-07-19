import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 65539 + index)
n = 4 + index % 4
cost = [r.randrange(8) for _ in range(n)]
entries = r.sample(range(1, n + 1), 1 + index % 2)
danger = r.sample(range(1, n + 1), 1 + (index // 2) % 2)
edges = [
    (u, v)
    for u in range(1, n + 1)
    for v in range(1, n + 1)
    if u != v and r.random() < 0.18
]
print(n, len(edges), len(entries), len(danger))
print(*cost)
print(*entries)
print(*danger)
for e in edges:
    print(*e)
