import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
rng = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
K = 1 + rng.randrange(2 + idx % 7)
ids = list(range(1, K + 1))
rng.shuffle(ids)
W = rng.randrange(K + 1)
known = {i: rng.randint(1, 30) for i in ids[:W]}
R = 1 + rng.randrange(3 + idx % 9)
Q = 1 + rng.randrange(4 + idx % 8)
runs = [(rng.randint(1, K), rng.randint(1, 15)) for _ in range(R)]
weights = [1000] * (K + 1)
for i, w in known.items():
    weights[i] = w
total = sum(weights[i] * c for i, c in runs)
budgets = [rng.randint(0, total + 100) for _ in range(Q)]
out = (
    [f"{K} {W} {R} {Q}"]
    + [f"{i} {known[i]}" for i in ids[:W]]
    + [f"{i} {c}" for i, c in runs]
    + list(map(str, budgets))
)
print("\n".join(out))
