import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
q = int(next(it))
files = [(next(it), next(it)) for _ in range(n)]
for _ in range(q):
    meta = [next(it) for _ in range(4)]
    k = int(next(it))
    ids = []
    for _ in range(k):
        x = int(next(it)) - 1
        j = len(ids)
        while j and files[ids[j - 1]][0] > files[x][0]:
            j -= 1
        ids.insert(j, x)
    out = meta + [str(k)]
    for x in ids:
        out.extend(files[x])
    print(*out)
