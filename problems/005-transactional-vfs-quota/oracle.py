import sys

t = sys.stdin.buffer.read().split()
p = 0


def take():
    global p
    x = t[p].decode()
    p += 1
    return x


P, N, B, I = map(int, (take(), take(), take(), take()))
a = [None] * (P + 1)
peak_b = peak_i = 0
sticky = 0
out = []


def usage():
    return sum(x is not None for x in a), sum(x or 0 for x in a if x is not None)


for _ in range(N):
    op = take()
    x = int(take())
    code = None
    if op == "CREATE":
        ino, used = usage()
        if a[x] is not None:
            code = "EXISTS"
        elif ino + 1 > I:
            code = "INODES"
        else:
            a[x] = 0
    elif op == "UNLINK":
        if a[x] is None:
            code = "NOENT"
        else:
            a[x] = None
    elif op == "TRUNCATE":
        new = int(take())
        if a[x] is None:
            code = "NOENT"
        else:
            ino, used = usage()
            if used - a[x] + new > B:
                code = "BYTES"
            else:
                a[x] = new
    else:
        off, length = int(take()), int(take())
        if a[x] is None:
            code = "NOENT"
        else:
            new = a[x] if length == 0 else max(a[x], off + length)
            ino, used = usage()
            if used - a[x] + new > B:
                code = "BYTES"
            else:
                a[x] = new
    if code in ("BYTES", "INODES"):
        sticky = 1
    out.append("OK" if code is None else "ERR " + code)
    ino, used = usage()
    peak_b = max(peak_b, used)
    peak_i = max(peak_i, ino)
ino, used = usage()
out.append(f"SUMMARY {used} {ino} {peak_b} {peak_i} {sticky}")
print("\n".join(out))
