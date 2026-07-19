import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
K, W, R, Q = next(it), next(it), next(it), next(it)
weight = [1000] * (K + 1)
for _ in range(W):
    op = next(it)
    w = next(it)
    weight[op] = w
runs = [(next(it), next(it)) for _ in range(R)]
out = []
for _ in range(Q):
    b = next(it)
    used = done = 0
    for op, cnt in runs:
        take = min(cnt, (b - used) // weight[op])
        done += take
        used += take * weight[op]
        if take < cnt:
            break
    out.append(f"{done} {used}")
print("\n".join(out))
