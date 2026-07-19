import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")

seed = int(sys.argv[1])
index = int(sys.argv[2])
if index == 999_999:
    n = 200_000
    fingerprints = [format(value, "x") for value in range(1, n + 1)]
    fingerprints[-1] = format(123_457, "x")
    print(n)
    print(*fingerprints)
    raise SystemExit(0)

rng = random.Random((seed << 32) ^ index)
n = rng.randint(1, min(36, 8 + index % 29))


def fresh(used):
    while True:
        width = rng.randint(1, 8)
        token = "".join(rng.choice("0123456789abcdef") for _ in range(width))
        if token not in used:
            used.add(token)
            return token


used = set()
fingerprints = [fresh(used) for _ in range(n)]
if n >= 2 and index % 4 != 0:
    duplicate_at = rng.randint(1, n - 1)
    fingerprints[duplicate_at] = fingerprints[rng.randrange(duplicate_at)]
if n >= 4 and index % 3 == 0:
    fingerprints[-1] = fingerprints[0]

print(n)
print(*fingerprints)
