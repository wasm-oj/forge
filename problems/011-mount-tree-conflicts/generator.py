import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random((seed << 32) ^ index)
n = 8 + index % 18
paths = []
for i in range(n):
    if paths and r.random() < 0.28:
        p = r.choice(paths)
        if r.random() < 0.55:
            p += "/x" + str(r.randrange(5))
    else:
        p = "/" + "/".join(
            "p" + str(r.randrange(12)) for _ in range(1 + r.randrange(3))
        )
    paths.append(p)
print(n)
for p in paths:
    print(r.choice("FD"), p)
