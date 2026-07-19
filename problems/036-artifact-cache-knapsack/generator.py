import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
N = r.randint(1, min(18, 5 + idx % 14))
C = r.randint(0, 45)
print(N, C)
for _ in range(N):
    print(r.randint(1, 55), r.randint(0, 100))
