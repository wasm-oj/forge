import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 31337 + index)
n = 5 + index % 8
d = 4 + index % 6
q = 15 + index % 15
cap = r.randrange(4, 15)
sizes = [r.randrange(1, 9) for _ in range(d)]
ops = []
for i in range(q):
    if i == q - 1 or r.random() < 0.4:
        ops.append(("G", r.randrange(1, n + 1)))
    else:
        ops.append(("P", r.randrange(1, n + 1), r.randrange(1, d + 1)))
print(n, d, q, cap)
print(*sizes)
for x in ops:
    print(*x)
