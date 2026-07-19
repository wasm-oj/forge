import sys

t = iter(sys.stdin.buffer.read().split())
H = int(next(t))
h = []
for _ in range(H):
    name = next(t)
    K = int(next(t))
    cs = []
    for _ in range(K):
        cid = next(t)
        tm = int(next(t))
        P = int(next(t))
        cs.append((cid, tm, [(next(t), next(t)) for _ in range(P)]))
    h.append((name, cs))
base = h[0][1]
out = []
allok = True
for name, cs in h[1:]:
    if [x[0] for x in cs] != [x[0] for x in base]:
        out.append(b"HOST " + name + b" CASE_ORDER")
        allok = False
        continue
    d = []
    for a, b in zip(base, cs):
        i = j = 0
        while i < len(a[2]) or j < len(b[2]):
            if j == len(b[2]) or i < len(a[2]) and a[2][i][0] < b[2][j][0]:
                d.append(a[0] + b"." + a[2][i][0])
                i += 1
            elif i == len(a[2]) or a[2][i][0] > b[2][j][0]:
                d.append(a[0] + b"." + b[2][j][0])
                j += 1
            else:
                if a[2][i][1] != b[2][j][1]:
                    d.append(a[0] + b"." + a[2][i][0])
                i += 1
                j += 1
    if d:
        out.append(b"HOST " + name + b" " + str(len(d)).encode() + b" " + b" ".join(d))
        allok = False
    else:
        out.append(b"HOST " + name + b" OK")
if allok:
    for i, c in enumerate(base):
        out.append(
            b"MEDIAN "
            + c[0]
            + b" "
            + str(sorted(x[1][i][1] for x in h)[(H - 1) // 2]).encode()
        )
sys.stdout.buffer.write(b"\n".join(out) + b"\n")
