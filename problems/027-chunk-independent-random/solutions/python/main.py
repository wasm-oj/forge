import sys

t = iter(sys.stdin.buffer.read().split())
a = int(next(t))
b = int(next(t))
S = int(next(t))
q = int(next(t))
M = (1 << 64) - 1


def byte(s, x):
    z = (s + 0x9E3779B97F4A7C15 * (x // 8 + 1)) & M
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M
    z ^= z >> 31
    return (z >> (8 * (x % 8))) & 255


def at(x):
    return byte(a, x) if x < S else byte(b, x - S)


p = 0
out = []
for _ in range(q):
    k = int(next(t))
    out.append(f"{at(p)} {at(p+k-1)}")
    p += k
print("\n".join(out))
