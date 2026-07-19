import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
m = int(next(it))
lock = []
for _ in range(n):
    lock.append((next(it), next(it), int(next(it))))
pay = [(next(it), int(next(it))) for _ in range(m)]
dig = sorted({x[1] for x in lock})
for d in dig:
    z = {x[2] for x in lock if x[1] == d}
    if len(z) > 1:
        print("LOCK_CONFLICT", d)
        raise SystemExit
for d in sorted({x[0] for x in pay}):
    if sum(x[0] == d for x in pay) > 1:
        print("DUPLICATE_PAYLOAD", d)
        raise SystemExit
pd = {x[0]: x[1] for x in pay}
req = {d: next(x[2] for x in lock if x[1] == d) for d in dig}
for d in dig:
    if d not in pd:
        print("MISSING", d)
        raise SystemExit
for d in sorted(pd):
    if d not in req:
        print("EXTRA", d)
        raise SystemExit
for d in dig:
    if req[d] != pd[d]:
        print("SIZE", d)
        raise SystemExit
allbytes = sum(x[2] for x in lock)
unique = sum(req.values())
print("VALID", len(req), unique, allbytes - unique)
