import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 1000003 + index)
n = 7 + index % 8
q = 3 + index % 5
print(n, q)
for i in range(n):
    print(f"src/p{i:02d}.c", f"{r.getrandbits(32):08x}")
for j in range(q):
    k = r.randrange(n + 1)
    ids = r.sample(range(1, n + 1), k)
    r.shuffle(ids)
    print("cc wasm32 o2", f"{r.getrandbits(32):08x}", k, *ids)
