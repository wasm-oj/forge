import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed + index * 1009)
n = 10 + index % 15
b = r.randrange(1, 10)
print(n, b)
for _ in range(n):
    print("f" + str(r.randrange(4)), r.randrange(13))
