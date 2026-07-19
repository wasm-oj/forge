import sys

it = iter(sys.stdin.buffer.read().split())
C = int(next(it))
n = [int(next(it)), int(next(it))]
a = [[], []]
for w in range(2):
    for _ in range(n[w]):
        t = next(it)
        a[w].append((t, 0 if t == b"C" else int(next(it))))
pc = [0, 0]
closed = [not n[0], not n[1]]
occ = [0, 0]
steps = 0
while True:
    if pc == n:
        print("SUCCESS", steps, *occ)
        break
    progress = False
    for w in range(2):
        if pc[w] == n[w]:
            continue
        t, k = a[w][pc[w]]
        o = 1 - w
        z = 0
        if t == b"W":
            if C - occ[w] >= k:
                occ[w] += k
                z = 1
        elif t == b"R":
            if occ[o] >= k:
                occ[o] -= k
                z = 1
            elif closed[o]:
                z = -1
        else:
            closed[w] = True
            z = 1
        if z < 0:
            print("FAIL", "AB"[w], steps, *occ)
            raise SystemExit
        if z:
            pc[w] += 1
            steps += 1
            progress = True
            closed[w] |= pc[w] == n[w]
    if not progress:
        print("DEADLOCK", steps, *occ)
        break
