import sys

t = sys.stdin.buffer.read().split()
it = iter(t)
N = int(next(it))
active = {}
clock = 0
out = []
for _ in range(N):
    op = next(it)
    if op == b"T":
        x = int(next(it))
        d = int(next(it))
        active[x] = d
    elif op == b"C":
        del active[int(next(it))]
    else:
        ready = int(next(it))
        if ready == 0 and active:
            clock = max(clock, min(active.values()))
        fired = sorted((d, x) for x, d in active.items() if d <= clock)
        for _, x in fired:
            del active[x]
        ids = [str(x) for _, x in fired]
        out.append(
            " ".join(map(str, (clock, ready, len(ids))))
            + (" " + " ".join(ids) if ids else "")
        )
print("\n".join(out))
