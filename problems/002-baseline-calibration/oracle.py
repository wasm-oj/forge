import sys

t = list(map(int, sys.stdin.buffer.read().split()))
it = iter(t)
P, S, N, Q = next(it), next(it), next(it), next(it)
obs = [(next(it), next(it), next(it)) for _ in range(N)]
out = []
for _ in range(Q):
    p, raw = next(it), next(it)
    a = {s: c for x, s, c in obs if x == p}
    if len(a) != S or len(set(a.values())) != 1:
        out.append("INVALID")
    else:
        b = next(iter(a.values()))
        out.append(f"{b} {max(0,raw-b)}")
print("\n".join(out))
