import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
n = r.randint(1, 5 + idx % 8)
paths = []
for _ in range(n):
    seg = [
        r.choice(("", ".", "..", "a", "b2", "x_y", "...", "..hidden"))
        for _ in range(r.randint(0, 10))
    ]
    paths.append("/" + "/".join(seg) + ("/" if r.random() < 0.3 else ""))
print(n)
print("\n".join(paths))
