import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
seed, index = int(sys.argv[1]), int(sys.argv[2])
randomizer = random.Random((seed << 32) ^ index)
alphabet = "AWRT"
if index == 999_999:
    n, q = 100_000, 80_000
    verdicts = "".join(alphabet[((i * 37) ^ (i >> 3)) & 3] for i in range(n))
    print(n, q)
    print(verdicts)
    for i in range(q):
        left = (i * 7_919) % n + 1
        length = (i * 104_729) % (n - left + 1) + 1
        print(left, left + length - 1, alphabet[i & 3])
else:
    n, q = randomizer.randint(1, 40), randomizer.randint(1, 40)
    verdicts = "".join(randomizer.choice(alphabet) for _ in range(n))
    print(n, q)
    print(verdicts)
    for _ in range(q):
        left = randomizer.randint(1, n)
        right = randomizer.randint(left, n)
        print(left, right, randomizer.choice(alphabet))
