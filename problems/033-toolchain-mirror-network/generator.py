import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 7919 + index)
n = 2 + index % 6
all_e = [(u, v, r.randrange(20)) for u in range(1, n + 1) for v in range(u + 1, n + 1)]
r.shuffle(all_e)
m = min(len(all_e), 5 + index % 8)
e = all_e[:m]
if index % 4 == 0:
    e = []
print(n, len(e))
for x in e:
    print(*x)
