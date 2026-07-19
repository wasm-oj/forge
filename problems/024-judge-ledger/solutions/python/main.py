import sys

it = iter(sys.stdin.buffer.read().split())
n = int(next(it))
q = int(next(it))
bad = [0] * (n + 2)
u = [[0] * (n + 1) for _ in range(4)]
s = [[0] * (n + 1) for _ in range(2)]
b = 1
while b < n:
    b *= 2
tm = [0] * (2 * b)
tv = [0] * (2 * b)
for i in range(1, n + 1):
    bad[i] = int(next(it))
    a = [int(next(it)) for _ in range(4)]
    for j in range(4):
        u[j][i] = u[j][i - 1] + (a[j] < 0)
    for j in range(2):
        s[j][i] = s[j][i - 1] + max(0, a[j])
    tm[b + i - 1] = max(0, a[2])
    tv[b + i - 1] = max(0, a[3])
for i in range(b - 1, 0, -1):
    tm[i] = max(tm[2 * i : 2 * i + 2])
    tv[i] = max(tv[2 * i : 2 * i + 2])
nb = [n + 1] * (n + 2)
for i in range(n, 0, -1):
    nb[i] = i if bad[i] else nb[i + 1]


def rmq(t, l, r):
    l += b - 1
    r += b - 1
    z = 0
    while l <= r:
        if l & 1:
            z = max(z, t[l])
            l += 1
        if not r & 1:
            z = max(z, t[r])
            r -= 1
        l //= 2
        r //= 2
    return z


out = []
for _ in range(q):
    l = int(next(it))
    r = int(next(it))
    f = int(next(it))
    e = nb[l] if f and nb[l] <= r else r
    z = [str(e - l + 1), str(bad[nb[l]] if nb[l] <= e else 0)]
    for j in range(2):
        z.append("null" if u[j][e] > u[j][l - 1] else str(s[j][e] - s[j][l - 1]))
    for j, t in ((2, tm), (3, tv)):
        z.append("null" if u[j][e] > u[j][l - 1] else str(rmq(t, l, e)))
    out.append(" ".join(z))
print("\n".join(out))
