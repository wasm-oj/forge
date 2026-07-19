import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
F, N, B = map(int, (next(it), next(it), next(it)))
size = [0] * (F + 1)
cur = [0] * (F + 1)
used = peak = 0
out = []
for _ in range(N):
    op = next(it)
    x = int(next(it))
    v = int(next(it))
    err = False
    if op == b"SEEK":
        cur[x] = v
    else:
        ns = (size[x] if v == 0 else max(size[x], cur[x] + v)) if op == b"WRITE" else v
        if ns > size[x] and ns - size[x] > B - used:
            err = True
        else:
            used += ns - size[x]
            size[x] = ns
            if op == b"WRITE" and v:
                cur[x] += v
    peak = max(peak, used)
    out.append(("ERR QUOTA" if err else "OK") + f" {size[x]} {cur[x]} {used}")
out.append(f"SUMMARY {used} {peak}")
print("\n".join(out))
