import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
q = int(next(it))
f = [(next(it), next(it)) for _ in range(n)]
output = sys.stdout
for _ in range(q):
    meta = [next(it) for _ in range(4)]
    k = int(next(it))
    ids = [int(next(it)) - 1 for _ in range(k)]
    ids.sort(key=lambda x: f[x][0])
    output.write(meta[0])
    for token in (*meta[1:], str(k)):
        output.write(" ")
        output.write(token)
    for x in ids:
        output.write(" ")
        output.write(f[x][0])
        output.write(" ")
        output.write(f[x][1])
    output.write("\n")
