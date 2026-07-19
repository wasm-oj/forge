import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
N, Q, C = next(it), next(it), next(it)
a = []
for _ in range(N):
    a.append((next(it), next(it), next(it)))
out = []
for _ in range(Q):
    l, r = next(it) - 1, next(it)
    bad = None
    si = sm = 0
    for j in range(l, r):
        k, ini, mx = a[j]
        if k == 64 or ini > C or (mx != -1 and mx < ini):
            bad = j + 1
            break
        si += ini
        sm += C if mx == -1 else min(C, mx)
    out.append(f"REJECT {bad}" if bad is not None else f"ACCEPT {si*65536} {sm*65536}")
print("\n".join(out))
