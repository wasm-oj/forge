import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed ^ index * 0x9E3779B1)
n = 5 + index % 10
rows = []
for i in range(n):
    t = r.choice("TB")
    path = f"d{r.randrange(5)}/f{i:02d}"
    z = r.randrange(10)
    payload = (
        "-"
        if z == 0
        else (
            "".join(chr(65 + r.randrange(26)) for _ in range(z))
            if t == "T"
            else bytes(r.randrange(256) for _ in range(z)).hex()
        )
    )
    rows.append((t, path, payload))
r.shuffle(rows)
print(n)
for x in rows:
    print(*x)
