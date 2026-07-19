import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
cnt = r.randint(1, 5 + idx % 7)
paths = []
while len(paths) < cnt:
    x = tuple(
        [r.randint(1, 3) for _ in range(r.randint(1, 4) - 1)] + [100 + len(paths)]
    )
    if x not in paths:
        paths.append(x)
M = r.randint(0, cnt)
O = cnt - M
sizes = [r.randint(0, 30) for _ in range(M)]
B = r.randint(0, sum(sizes) + 20)
I = r.randint(0, 20)
out = [f"{M} {O} {B} {I}"]
for x, z in zip(paths[:M], sizes):
    out.append(f"{len(x)} {' '.join(map(str,x))} {z}")
for x in paths[M:]:
    out.append(f"{len(x)} {' '.join(map(str,x))}")
print("\n".join(out))
