import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random((seed << 24) ^ index)
n = 4 + index % 8
limf = n
limb = 5000
rows = []
off = 0
pending = False
for i in range(n):
    t = r.choices(list("FDGP"), [5, 2, 1, 1])[0]
    if pending:
        t = r.choice("FD")
    name = "d" + str(r.randrange(20)) + ("/f" + str(i) if r.random() < 0.5 else "")
    size = 0 if t == "D" else (len(name) + 1 if t in "GP" else r.randrange(40))
    c = r.randrange(1000)
    rows.append([off, t, name, size, c, c])
    off += 512 + ((size + 511) // 512) * 512
    pending = t in "GP"
mode = index % 5
if mode == 1:
    rows[r.randrange(n)][4] += 1
elif mode == 2:
    rows[r.randrange(n)][0] += 512
elif mode == 3:
    rows[r.randrange(n)][1] = "X"
elif mode == 4 and n >= 2:
    rows[-2][1] = "G"
    rows[-2][2] = "meta"
    rows[-2][3] = 5
    rows[-1][1] = "P"
print(n, limf, limb)
for x in rows:
    print(*x)
