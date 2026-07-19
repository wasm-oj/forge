import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
seed, index = int(sys.argv[1]), int(sys.argv[2])
randomizer = random.Random((seed << 32) ^ index)
if index == 999_999:
    n, k = 200_000, 5_000
    costs = [(i + 1) * 1_000_003 for i in range(n)]
else:
    n = randomizer.randint(1, 45)
    k = randomizer.randint(1, min(n, 12))
    costs = [randomizer.randint(0, 100) for _ in range(n)]
print(n, k)
print(*costs)
