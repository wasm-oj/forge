import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
m = int(next(it))
lock = []
total = 0
for _ in range(n):
    next(it)
    d = next(it)
    z = int(next(it))
    lock.append((d, z))
    total += z
pay = [(next(it), int(next(it))) for _ in range(m)]
lock.sort()
pay.sort()
req = []
i = 0
while i < n:
    j = i + 1
    while j < n and lock[j][0] == lock[i][0]:
        j += 1
    if any(lock[k][1] != lock[i][1] for k in range(i + 1, j)):
        print("LOCK_CONFLICT", lock[i][0])
        raise SystemExit
    req.append(lock[i])
    i = j
for i in range(1, m):
    if pay[i][0] == pay[i - 1][0]:
        print("DUPLICATE_PAYLOAD", pay[i][0])
        raise SystemExit
missing = extra = size_error = None
i = j = 0
while i < len(req) or j < len(pay):
    if j == len(pay) or (i < len(req) and req[i][0] < pay[j][0]):
        if missing is None:
            missing = req[i][0]
        i += 1
    elif i == len(req) or pay[j][0] < req[i][0]:
        if extra is None:
            extra = pay[j][0]
        j += 1
    else:
        if req[i][1] != pay[j][1] and size_error is None:
            size_error = req[i][0]
        i += 1
        j += 1
if missing is not None:
    print("MISSING", missing)
    raise SystemExit
if extra is not None:
    print("EXTRA", extra)
    raise SystemExit
if size_error is not None:
    print("SIZE", size_error)
    raise SystemExit
unique = sum(z for _, z in req)
print("VALID", len(req), unique, total - unique)
