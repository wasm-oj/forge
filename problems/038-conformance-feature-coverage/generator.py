import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
F = r.randint(1, min(10, 3 + idx % 8))
N = r.randint(1, min(15, 5 + idx % 11))
B = r.randint(0, 35)
print(F, N, B)
for _ in range(N):
    a = [x for x in range(1, F + 1) if r.random() < 0.4]
    print(r.randint(0, 15), len(a), *a)
