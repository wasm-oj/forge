import sys

a = list(map(int, sys.stdin.read().split()))
n, m, c = a[:3]
g = [[] for _ in range(n)]
p = 3
for _ in range(m):
    u, v = a[p] - 1, a[p + 1] - 1
    p += 2
    g[u].append(v)
ans = set()
for s in a[p : p + c]:
    st = [s - 1]
    seen = {s - 1}
    while st:
        u = st.pop()
        for v in g[u]:
            if v not in seen:
                seen.add(v)
                st.append(v)
    ans |= seen
print(len(ans))
print(" ".join(str(x + 1) for x in sorted(ans)))
