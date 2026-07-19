import re, sys


def path_ok(p):
    return (
        not p.startswith("/")
        and not p.endswith("/")
        and all(
            x not in ("", ".", "..") and re.fullmatch(r"[a-z0-9._-]+", x)
            for x in p.split("/")
        )
    )


it = iter(sys.stdin.read().split())
n, mf, mb = map(int, (next(it), next(it), next(it)))
expected = files = used = 0
pending = None
for i in range(1, n + 1):
    o = int(next(it))
    t = next(it)
    name = next(it)
    size = int(next(it))
    a = int(next(it))
    b = int(next(it))
    err = None
    if o != expected:
        err = "OFFSET"
    elif a != b:
        err = "CHECKSUM"
    elif t not in "FDGP":
        err = "TYPE"
    elif t in "GP" and pending is not None:
        err = "STATE"
    elif t in "GP" and size != len(name.encode()) + 1:
        err = "META_SIZE"
    elif t in "GP" and not path_ok(name):
        err = "PATH"
    elif t in "FD" and not path_ok(pending if pending is not None else name):
        err = "PATH"
    elif t == "D" and size != 0:
        err = "ENTRY_SIZE"
    elif t == "F" and (files + 1 > mf or used + size > mb):
        err = "LIMIT"
    if err:
        print("REJECT", i, err)
        raise SystemExit
    expected += 512 + ((size + 511) // 512) * 512
    if t in "GP":
        pending = name
    else:
        pending = None
        if t == "F":
            files += 1
            used += size
if pending is not None:
    print("REJECT", n + 1, "STATE")
else:
    print("ACCEPT", files, used, expected)
