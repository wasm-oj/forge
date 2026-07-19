import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
F, N, B = map(int, (next(it), next(it), next(it)))
size = [0] * (F + 1)
cur = [0] * (F + 1)
peak = 0
out = []
for _ in range(N):
    op = next(it)
    x = int(next(it))
    v = int(next(it))
    err = False
    if op == b"SEEK":
        cur[x] = v
    else:
        new = (size[x] if v == 0 else max(size[x], cur[x] + v)) if op == b"WRITE" else v
        used = sum(size)
        if used - size[x] + new > B:
            err = True
        else:
            size[x] = new
            if op == b"WRITE" and v:
                cur[x] += v
    used = sum(size)
    peak = max(peak, used)
    out.append(("ERR QUOTA" if err else "OK") + f" {size[x]} {cur[x]} {used}")
out.append(f"SUMMARY {sum(size)} {peak}")
print("\n".join(out))
