import sys

it = iter(sys.stdin.read().split())
n, d, q = int(next(it)), int(next(it)), int(next(it))
cap = int(next(it))
size = [int(next(it)) for _ in range(d)]
cached = [False] * d
lp = [-1] * d
ln = [-1] * d
rh = [-1] * d
node = [-1] * n
rp = [-1] * n
rn = [-1] * n
head = tail = -1
used = 0
out = []


def lremove(x):
    global head, tail
    if lp[x] >= 0:
        ln[lp[x]] = ln[x]
    else:
        head = ln[x]
    if ln[x] >= 0:
        lp[ln[x]] = lp[x]
    else:
        tail = lp[x]
    lp[x] = ln[x] = -1


def touch(x):
    global head, tail
    if cached[x]:
        lremove(x)
    cached[x] = True
    lp[x] = tail
    if tail >= 0:
        ln[tail] = x
    else:
        head = x
    tail = x


def detach(u):
    x = node[u]
    if x < 0:
        return
    if rp[u] >= 0:
        rn[rp[u]] = rn[u]
    else:
        rh[x] = rn[u]
    if rn[u] >= 0:
        rp[rn[u]] = rp[u]
    node[u] = rp[u] = rn[u] = -1


def attach(u, x):
    node[u] = x
    rn[u] = rh[x]
    if rh[x] >= 0:
        rp[rh[x]] = u
    rh[x] = u
    rp[u] = -1


for _ in range(q):
    op = next(it)
    u = int(next(it)) - 1
    if op == "G":
        x = node[u]
        if x < 0:
            out.append("MISS")
        else:
            touch(x)
            out.append(f"HIT {x+1}")
        continue
    x = int(next(it)) - 1
    detach(u)
    if size[x] > cap:
        continue
    if not cached[x]:
        used += size[x]
    touch(x)
    attach(u, x)
    while used > cap:
        dead = head
        lremove(dead)
        cached[dead] = False
        used -= size[dead]
        v = rh[dead]
        while v >= 0:
            z = rn[v]
            node[v] = rp[v] = rn[v] = -1
            v = z
        rh[dead] = -1
print("\n".join(out))
