import sys

a = list(map(int, sys.stdin.read().split()))
n, m = a[:2]
g = [[] for _ in range(n)]
rg = [[] for _ in range(n)]
edges = []
selfloop = [False] * n
p = 2
for _ in range(m):
    u, v = a[p] - 1, a[p + 1] - 1
    p += 2
    g[u].append(v)
    rg[v].append(u)
    edges.append((u, v))
    selfloop[u] |= u == v
seen = [False] * n
cur = [0] * n
order = []
for s in range(n):
    if seen[s]:
        continue
    seen[s] = True
    st = [s]
    while st:
        u = st[-1]
        if cur[u] < len(g[u]):
            v = g[u][cur[u]]
            cur[u] += 1
            if not seen[v]:
                seen[v] = True
                st.append(v)
        else:
            order.append(u)
            st.pop()
comp = [-1] * n
members = []
for s in reversed(order):
    if comp[s] >= 0:
        continue
    cid = len(members)
    mem = []
    comp[s] = cid
    st = [s]
    while st:
        u = st.pop()
        mem.append(u)
        for v in rg[u]:
            if comp[v] < 0:
                comp[v] = cid
                st.append(v)
    members.append(mem)
members = [[] for _ in members]
for i, c in enumerate(comp):
    members[c].append(i)
indeg = [False] * len(members)
for u, v in edges:
    if comp[u] != comp[v]:
        indeg[comp[v]] = True
cyc = []
for i in range(n):
    c = comp[i]
    if members[c][0] == i and (len(members[c]) > 1 or selfloop[i]):
        cyc.append(members[c])
out = [f"{len(cyc)} {sum(not x for x in indeg)}"]
out += [str(len(x)) + " " + " ".join(str(v + 1) for v in x) for x in cyc]
print("\n".join(out))
