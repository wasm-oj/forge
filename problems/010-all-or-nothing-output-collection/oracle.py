import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
N, Q, U = map(int, (next(it), next(it), next(it)))
a = sorted((next(it).decode(), int(next(it)), int(next(it))) for _ in range(N))
out = []
for _ in range(Q):
    b = int(next(it))
    if U > b:
        out.append("ERR QUOTA -")
        continue
    used = U
    ans = None
    for path, m, x in a:
        if m != x:
            ans = f"ERR MISMATCH {path}"
            break
        if used + m > b:
            ans = f"ERR QUOTA {path}"
            break
        used += m
    out.append(ans or f"OK {N} {used}")
print("\n".join(out))
