import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 101 + index)
n = 8 + index % 8
pool = [f"{i:08x}" for i in range(1, 6)]
sizes = {d: r.randrange(20) for d in pool}
lock = [(f"p{i}", r.choice(pool), 0) for i in range(n)]
lock = [(a, d, sizes[d]) for a, d, _ in lock]
need = sorted({d for _, d, _ in lock})
pay = [(d, sizes[d]) for d in need]
mode = index % 6
if mode == 1 and n > 1:
    lock[1] = (lock[1][0], lock[0][1], lock[0][2] + 1)
elif mode == 2:
    pay.append(pay[0])
elif mode == 3:
    pay = pay[1:]
elif mode == 4:
    pay.append(("ffffffff", 3))
elif mode == 5:
    pay[0] = (pay[0][0], pay[0][1] + 1)
print(n, len(pay))
for x in lock:
    print(*x)
for x in pay:
    print(*x)
