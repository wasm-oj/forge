import sys

it = iter(sys.stdin.buffer.read().split())
n = int(next(it))
state = {}
q = []
head = active = waiting = 0
out = []
for _ in range(n):
    t = next(it)
    if t == b"A":
        x = int(next(it))
        if not active:
            active = x
            state[x] = 2
        else:
            state[x] = 1
            q.append(x)
            waiting += 1
    elif t == b"C":
        x = int(next(it))
        if state.get(x) == 1:
            state[x] = 3
            waiting -= 1
        elif state.get(x) == 2:
            state[x] = 3
            active = 0
    elif active:
        state[active] = 3
        active = 0
    while not active and head < len(q):
        x = q[head]
        head += 1
        if state[x] == 1:
            state[x] = 2
            active = x
            waiting -= 1
    out.append(f"{active} {waiting}")
print("\n".join(out))
