import sys

it = iter(sys.stdin.buffer.read().split())
n = int(next(it))
by = {}
jobs = [None]
epoch = bg = 0
out = []
for _ in range(n):
    t = next(it).decode()
    if t in ("B", "F"):
        k = next(it)
        i = by.get(k, 0)
        live = i and jobs[i][3] and (jobs[i][2] == "F" or jobs[i][1] == epoch)
        if live:
            out.append(f"JOIN {i}")
        else:
            i = len(jobs)
            jobs.append([k, epoch, t, True])
            by[k] = i
            bg += t == "B"
            out.append(f"NEW {i}")
    elif t == "S":
        out.append(f"CANCEL {bg}")
        bg = 0
        epoch += 1
    else:
        i = int(next(it))
        live = (
            i < len(jobs) and jobs[i][3] and (jobs[i][2] == "F" or jobs[i][1] == epoch)
        )
        if not live:
            out.append("STALE")
        else:
            jobs[i][3] = False
            bg -= jobs[i][2] == "B"
            if by.get(jobs[i][0]) == i:
                del by[jobs[i][0]]
            out.append("DONE")
print("\n".join(out))
