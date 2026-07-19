import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
N, Q, U = map(int, (next(it), next(it), next(it)))
a = sorted((next(it), int(next(it)), int(next(it))) for _ in range(N))
pre = [0]
mismatch = N
for i, (_, m, x) in enumerate(a):
    pre.append(pre[-1] + m)
    if mismatch == N and m != x:
        mismatch = i
k = 0
out = []
for _ in range(Q):
    b = int(next(it))
    if b < U:
        out.append("ERR QUOTA -")
        continue
    cap = b - U
    while k < N and pre[k + 1] <= cap:
        k += 1
    if k < mismatch:
        out.append("ERR QUOTA " + a[k][0].decode())
    elif mismatch < N:
        out.append("ERR MISMATCH " + a[mismatch][0].decode())
    elif k < N:
        out.append("ERR QUOTA " + a[k][0].decode())
    else:
        out.append(f"OK {N} {U+pre[N]}")
print("\n".join(out))
