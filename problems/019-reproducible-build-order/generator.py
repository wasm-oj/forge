import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 17 + index)
n = 8 + index % 10
names = [f"p{i:02d}" for i in range(n)]
edges = []
for a in range(n):
    for b in range(a):
        if r.random() < 0.12:
            edges.append((names[a], names[b]))
if index % 5 == 1:
    edges.append((names[0], "ghost"))
elif index % 5 == 2:
    edges.extend(((names[0], names[1]), (names[1], names[0])))
edges = list(dict.fromkeys(edges))
print(n, len(edges))
print(*names, sep="\n")
for e in edges:
    print(*e)
