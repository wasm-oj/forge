import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
N, Q = int(next(it)), int(next(it))
a = [(next(it), int(next(it))) for _ in range(N)]
i = used = 0
c = {b"O": 0, b"E": 0, b"F": 0}
out = []
for _ in range(Q):
    b = int(next(it))
    while i < N and used + a[i][1] <= b:
        s, x = a[i]
        used += x
        c[s] += x
        i += 1
    d = c.copy()
    fail = 0
    if i < N:
        s, x = a[i]
        d[s] += b - used
        fail = i + 1
    out.append(f"{fail} {d[b'O']} {d[b'E']} {d[b'F']}")
print("\n".join(out))
