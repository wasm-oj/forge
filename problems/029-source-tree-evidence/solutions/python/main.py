import sys

l = sys.stdin.buffer.read().splitlines()
n, E = l[0].split()
a = []
for s in l[1:]:
    p = s.split()[1]
    if p != E and not p.startswith(E + b"/"):
        a.append((p, s))
a.sort()
sys.stdout.buffer.write(
    str(len(a)).encode() + b"\n" + b"".join(s + b"\n" for _, s in a)
)
