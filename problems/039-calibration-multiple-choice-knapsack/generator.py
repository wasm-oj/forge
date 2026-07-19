import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
G = r.randint(1, min(8, 3 + idx % 6))
C = r.randint(0, 35)
print(G, C)
for _ in range(G):
    k = r.randint(1, 4)
    a = []
    for _ in range(k):
        a.extend((r.randint(0, 40), r.randint(0, 80)))
    print(k, *a)
