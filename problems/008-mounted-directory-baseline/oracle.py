import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
M, O, B, I = next(it), next(it), next(it), next(it)
dirs = {()}
total = 0
for j in range(M + O):
    k = next(it)
    x = tuple(next(it) for _ in range(k))
    for q in range(k):
        dirs.add(x[:q])
    if j < M:
        total += next(it)
ino = len(dirs) + M + O
if total <= B and ino <= I:
    print("ACCEPT", total, ino, B - total, I - ino)
else:
    print("REJECT", total, ino, max(0, total - B), max(0, ino - I))
