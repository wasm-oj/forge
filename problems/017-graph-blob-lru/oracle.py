import sys

it = iter(sys.stdin.read().split())
n, d, q = int(next(it)), int(next(it)), int(next(it))
cap = int(next(it))
size = [int(next(it)) for _ in range(d)]
node = [None] * n
lru = []
out = []


def touch(x):
    if x in lru:
        lru.remove(x)
    lru.append(x)


for _ in range(q):
    op = next(it)
    u = int(next(it)) - 1
    if op == "G":
        if node[u] is None:
            out.append("MISS")
        else:
            touch(node[u])
            out.append(f"HIT {node[u]+1}")
    else:
        x = int(next(it)) - 1
        node[u] = None
        if size[x] > cap:
            continue
        touch(x)
        node[u] = x
        while sum(size[v] for v in lru) > cap:
            dead = lru.pop(0)
            for i in range(n):
                if node[i] == dead:
                    node[i] = None
print("\n".join(out))
