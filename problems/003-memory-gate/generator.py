import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
N = r.randint(1, 5 + idx % 8)
Q = r.randint(1, 8)
C = r.randint(1, 20)
a = []
for _ in range(N):
    k = 64 if r.random() < 0.2 else 32
    ini = r.randint(0, C + 5)
    mx = -1 if r.random() < 0.3 else r.randint(0, C + 8)
    a.append((k, ini, mx))
out = [f"{N} {Q} {C}"] + [f"{x} {y} {z}" for x, y, z in a]
for _ in range(Q):
    l = r.randint(1, N)
    rr = r.randint(l, N)
    out.append(f"{l} {rr}")
print("\n".join(out))
