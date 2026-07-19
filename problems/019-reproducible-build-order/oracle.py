import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
m = int(next(it))
names = [next(it) for _ in range(n)]
known = set(names)
edges = []
bad = None
for i in range(1, m + 1):
    a, b = next(it), next(it)
    if bad is None and (a not in known or b not in known):
        bad = i
    edges.append((a, b))
if bad is not None:
    print("INVALID DANGLING", bad)
    raise SystemExit
left = set(names)
order = []
while left:
    ready = [x for x in left if all(a != x or b not in left for a, b in edges)]
    if not ready:
        print("INVALID CYCLE")
        raise SystemExit
    x = min(ready)
    left.remove(x)
    order.append(x)
print("ORDER", *order)
