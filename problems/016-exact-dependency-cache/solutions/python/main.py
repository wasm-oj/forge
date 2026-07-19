import sys

a = list(map(int, sys.stdin.read().split()))
n, h, m, q = a[:4]
byte_width = (n + 7) // 8
rows = [bytearray(byte_width) for _ in range(h)]
p = 4
for _ in range(m):
    s, x = a[p] - 1, a[p + 1] - 1
    p += 2
    rows[x][s >> 3] |= 1 << (s & 7)
mask = [int.from_bytes(row, "little") for row in rows]
del rows
out = []
for _ in range(q):
    k = a[p]
    p += 1
    v = 0
    for x in a[p : p + k]:
        v |= mask[x - 1]
    p += k
    out.append(str(v.bit_count()))
print("\n".join(out))
