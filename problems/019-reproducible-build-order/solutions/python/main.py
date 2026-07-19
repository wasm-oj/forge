import bisect, heapq, sys

it = iter(sys.stdin.read().split())
n = int(next(it))
m = int(next(it))
names = [next(it) for _ in range(n)]
name_order = sorted((name, i) for i, name in enumerate(names))


def find_id(name):
    position = bisect.bisect_left(name_order, (name, -1))
    return (
        name_order[position][1]
        if position < n and name_order[position][0] == name
        else None
    )


g = [[] for _ in range(n)]
deg = [0] * n
bad = None
for i in range(1, m + 1):
    a, b = next(it), next(it)
    x, y = find_id(a), find_id(b)
    if x is None or y is None:
        if bad is None:
            bad = i
    else:
        g[y].append(x)
        deg[x] += 1
if bad is not None:
    print("INVALID DANGLING", bad)
    raise SystemExit
h = [(names[i], i) for i in range(n) if deg[i] == 0]
heapq.heapify(h)
out = []
while h:
    name, u = heapq.heappop(h)
    out.append(name)
    for v in g[u]:
        deg[v] -= 1
        if deg[v] == 0:
            heapq.heappush(h, (names[v], v))
print("INVALID CYCLE" if len(out) < n else "ORDER " + " ".join(out))
