import itertools, sys

a = list(map(int, sys.stdin.read().split()))
n, m = a[:2]
e = [tuple(a[i : i + 3]) for i in range(2, len(a), 3)]
if n == 1:
    print("COST 0")
    raise SystemExit
best = None
for take in itertools.combinations(e, n - 1):
    p = list(range(n))

    def f(x):
        while p[x] != x:
            p[x] = p[p[x]]
            x = p[x]
        return x

    ok = True
    for u, v, _ in take:
        x, y = f(u - 1), f(v - 1)
        if x == y:
            ok = False
            break
        p[x] = y
    if ok:
        z = sum(x[2] for x in take)
        best = z if best is None else min(best, z)
print("IMPOSSIBLE" if best is None else f"COST {best}")
