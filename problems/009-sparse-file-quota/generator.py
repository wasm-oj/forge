import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
F = r.randint(1, 3 + idx % 5)
N = r.randint(1, 8 + idx % 10)
B = r.randint(0, 50)
out = [f"{F} {N} {B}"]
for _ in range(N):
    out.append(
        f"{r.choice(('SEEK','WRITE','TRUNCATE'))} {r.randint(1,F)} {r.randint(0,45)}"
    )
print("\n".join(out))
