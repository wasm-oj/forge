import sys
from bisect import bisect_right

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
K, W, R, Q = next(it), next(it), next(it), next(it)
weight = [1000] * (K + 1)
for _ in range(W):
    op = next(it)
    weight[op] = next(it)
pc = [0]
pn = [0]
rw = []
rc = []
for _ in range(R):
    op, c = next(it), next(it)
    rw.append(weight[op])
    rc.append(c)
    pc.append(pc[-1] + c * weight[op])
    pn.append(pn[-1] + c)
out = []
for _ in range(Q):
    b = next(it)
    i = bisect_right(pc, b) - 1
    done, cost = pn[i], pc[i]
    if i < R:
        take = min(rc[i], (b - cost) // rw[i])
        done += take
        cost += take * rw[i]
    out.append(f"{done} {cost}")
print("\n".join(out))
