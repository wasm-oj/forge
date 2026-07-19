import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
N = r.randint(1, 5 + idx % 10)
Q = r.randint(1, 10)
a = [(r.choice("OEF"), r.randint(1, 20)) for _ in range(N)]
total = sum(x for _, x in a)
b = sorted(r.randint(0, total + 15) for _ in range(Q))
print("\n".join([f"{N} {Q}"] + [f"{s} {x}" for s, x in a] + list(map(str, b))))
