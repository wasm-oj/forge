import random, sys

if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")
r = random.Random((int(sys.argv[1]) << 32) ^ int(sys.argv[2]))
idx = int(sys.argv[2])
P = r.randint(1, 3 + idx % 6)
N = r.randint(1, 8 + idx % 10)
B = r.randint(0, 40)
I = r.randint(0, P)
out = [f"{P} {N} {B} {I}"]
for _ in range(N):
    op = r.choice(("CREATE", "WRITE", "TRUNCATE", "UNLINK"))
    x = r.randint(1, P)
    if op == "WRITE":
        out.append(f"{op} {x} {r.randint(0,30)} {r.randint(0,15)}")
    elif op == "TRUNCATE":
        out.append(f"{op} {x} {r.randint(0,45)}")
    else:
        out.append(f"{op} {x}")
print("\n".join(out))
