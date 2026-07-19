import sys


def main():
    tok = sys.stdin.read().split()
    assert len(tok) >= 3
    n, m, c = map(int, tok[:3])
    assert (
        1 <= n <= 200000
        and 0 <= m <= 400000
        and 0 <= c <= n
        and len(tok) == 3 + 2 * m + c
    )
    edges = []
    seen = set()
    p = 3
    for _ in range(m):
        u, v = map(int, tok[p : p + 2])
        p += 2
        assert 1 <= u <= n and 1 <= v <= n and u != v and (u, v) not in seen
        seen.add((u, v))
        edges.append((u, v))
    changed = list(map(int, tok[p:]))
    assert len(changed) == len(set(changed)) and all(1 <= x <= n for x in changed)
    indeg = [0] * n
    g = [[] for _ in range(n)]
    for u, v in edges:
        g[u - 1].append(v - 1)
        indeg[v - 1] += 1
    q = [i for i, x in enumerate(indeg) if x == 0]
    for u in q:
        for v in g[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                q.append(v)
    assert len(q) == n


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
