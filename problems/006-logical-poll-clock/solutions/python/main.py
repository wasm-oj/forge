import heapq, sys

t = sys.stdin.buffer.read().split()
it = iter(t)
N = int(next(it))
h = []
active = [False] * (N + 1)
clock = 0
out = []
for _ in range(N):
    op = next(it)
    if op == b"T":
        x, d = int(next(it)), int(next(it))
        active[x] = True
        heapq.heappush(h, (d, x))
    elif op == b"C":
        active[int(next(it))] = False
    else:
        ready = int(next(it))
        while h and not active[h[0][1]]:
            heapq.heappop(h)
        if ready == 0 and h:
            clock = max(clock, h[0][0])
        f = []
        while h and h[0][0] <= clock:
            d, x = heapq.heappop(h)
            if active[x]:
                active[x] = False
                f.append(x)
        out.append(
            f"{clock} {ready} {len(f)}" + (" " + " ".join(map(str, f)) if f else "")
        )
print("\n".join(out))
