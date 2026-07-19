import sys, collections

a = list(map(int, sys.stdin.read().split()))
L, R, M = a[:3]
g = [[] for _ in range(L)]
p = 3
for _ in range(M):
    g[a[p] - 1].append(a[p + 1] - 1)
    p += 2
pu = [-1] * L
pv = [-1] * R
dist = [-1] * L
matching = 0
while True:
    q = collections.deque()
    for u in range(L):
        dist[u] = 0 if pu[u] < 0 else -1
        if pu[u] < 0:
            q.append(u)
    terminal = -1
    while q:
        u = q.popleft()
        if terminal >= 0 and dist[u] >= terminal:
            continue
        for v in g[u]:
            w = pv[v]
            if w < 0:
                terminal = dist[u]
            elif dist[w] < 0:
                dist[w] = dist[u] + 1
                q.append(w)
    if terminal < 0:
        break
    cur = [0] * L
    for root in range(L):
        if pu[root] >= 0:
            continue
        su = [root]
        sv = []
        ok = False
        while su:
            u = su[-1]
            while cur[u] < len(g[u]):
                v = g[u][cur[u]]
                cur[u] += 1
                w = pv[v]
                if w < 0 and dist[u] == terminal:
                    pu[u] = v
                    pv[v] = u
                    for i in range(len(sv) - 1, -1, -1):
                        pu[su[i]] = sv[i]
                        pv[sv[i]] = su[i]
                    ok = True
                    break
                if w >= 0 and dist[u] < terminal and dist[w] == dist[u] + 1:
                    sv.append(v)
                    su.append(w)
                    break
            if ok:
                break
            if su and cur[su[-1]] >= len(g[su[-1]]):
                dist[su[-1]] = -1
                su.pop()
                if sv:
                    sv.pop()
        if ok:
            matching += 1
print(matching)
