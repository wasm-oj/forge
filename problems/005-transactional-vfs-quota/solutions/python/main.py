import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
P, N, B, I = map(int, (next(it), next(it), next(it), next(it)))
a = [None] * (P + 1)
used = ino = peak_b = peak_i = sticky = 0
out = []
for _ in range(N):
    op = next(it)
    x = int(next(it))
    err = None
    if op == b"CREATE":
        if a[x] is not None:
            err = "EXISTS"
        elif ino == I:
            err = "INODES"
        else:
            a[x] = 0
            ino += 1
    elif op == b"UNLINK":
        if a[x] is None:
            err = "NOENT"
        else:
            used -= a[x]
            a[x] = None
            ino -= 1
    else:
        if op == b"WRITE":
            off, length = int(next(it)), int(next(it))
            new = (
                a[x]
                if length == 0 and a[x] is not None
                else (0 if length == 0 else max(a[x] or 0, off + length))
            )
        else:
            new = int(next(it))
        if a[x] is None:
            err = "NOENT"
        elif new > a[x] and new - a[x] > B - used:
            err = "BYTES"
        else:
            used += new - a[x]
            a[x] = new
    if err in ("BYTES", "INODES"):
        sticky = 1
    out.append("OK" if err is None else "ERR " + err)
    peak_b = max(peak_b, used)
    peak_i = max(peak_i, ino)
out.append(f"SUMMARY {used} {ino} {peak_b} {peak_i} {sticky}")
print("\n".join(out))
