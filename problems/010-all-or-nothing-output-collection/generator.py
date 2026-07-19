import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
N = r.randint(1, 5 + idx % 8)
Q = r.randint(1, 9)
U = r.randint(0, 15)
a = []
for i in range(N):
    m = r.randint(0, 20)
    a.append((f"/p-{i}", m, m + (r.choice((0, 0, 0, 1)))))
r.shuffle(a)
bud = sorted(r.randint(0, U + sum(x[1] for x in a) + 15) for _ in range(Q))
print(
    "\n".join(
        [f"{N} {Q} {U}"] + [f"{p} {m} {x}" for p, m, x in a] + list(map(str, bud))
    )
)
