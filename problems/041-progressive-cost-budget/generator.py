import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")

seed = int(sys.argv[1])
index = int(sys.argv[2])
if index == 999_999:
    n = q = 200_000
    costs = [999_999_999_999] * 10_001 + [0] * 189_999
    total = sum(costs)
    print(n, q)
    for offset in range(0, n, 1_000):
        print(*costs[offset : offset + 1_000])
    budgets = [total] * q
    for offset in range(0, q, 1_000):
        print(*budgets[offset : offset + 1_000])
    raise SystemExit(0)

randomizer = random.Random((seed << 32) ^ index)
n = randomizer.randint(1, min(80, 8 + index % 73))
q = randomizer.randint(1, min(80, 8 + (index * 7) % 73))

costs = []
for stage in range(n):
    selector = randomizer.randrange(8)
    if selector < 2:
        costs.append(0)
    elif selector == 2:
        costs.append(10**12 - randomizer.randrange(1000))
    else:
        costs.append(randomizer.randrange(1, 10001))

total = sum(costs)
budgets = [randomizer.randrange(total + 10001) for _ in range(q)]
if q >= 1:
    budgets[0] = 0
if q >= 2:
    budgets[1] = total
if q >= 3:
    budgets[2] = max(0, total - 1)
budgets.sort()

print(n, q)
print(*costs)
print(*budgets)
