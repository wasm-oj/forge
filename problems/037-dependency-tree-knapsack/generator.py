import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
N = r.randint(1, min(18, 5 + idx % 14))
C = r.randint(0, 40)
print(N, C)
for i in range(1, N + 1):
    print(r.randint(0, i - 1), r.randint(1, 20), r.randint(0, 70))
