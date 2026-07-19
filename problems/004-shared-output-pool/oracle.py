import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
N, Q = int(next(it)), int(next(it))
a = [(next(it).decode(), int(next(it))) for _ in range(N)]
out = []
for _ in range(Q):
    b = int(next(it))
    used = 0
    c = {"O": 0, "E": 0, "F": 0}
    fail = 0
    for i, (s, x) in enumerate(a, 1):
        take = min(x, b - used)
        c[s] += take
        used += take
        if take < x:
            fail = i
            break
    out.append(f"{fail} {c['O']} {c['E']} {c['F']}")
print("\n".join(out))
