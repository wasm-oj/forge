import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
P = r.randint(1, 3 + idx % 5)
S = r.randint(1, 3 + idx % 4)
obs = []
for p in range(1, P + 1):
    base = r.randint(0, 30)
    for s in range(1, S + 1):
        if r.random() < 0.75:
            obs.append((p, s, base + (1 if r.random() < 0.15 else 0)))
r.shuffle(obs)
Q = r.randint(1, 8)
out = [f"{P} {S} {len(obs)} {Q}"] + [f"{a} {b} {c}" for a, b, c in obs]
out += [f"{r.randint(1,P)} {r.randint(0,50)}" for _ in range(Q)]
print("\n".join(out))
