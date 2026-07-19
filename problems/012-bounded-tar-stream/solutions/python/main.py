import re, sys


def ok(p):
    return (
        not p.startswith(b"/")
        and not p.endswith(b"/")
        and all(
            x not in (b"", b".", b"..") and re.fullmatch(rb"[a-z0-9._-]+", x)
            for x in p.split(b"/")
        )
    )


n, limit_n, limit_b = map(int, sys.stdin.buffer.readline().split())
off = count = used = 0
pending = None
for i in range(1, n + 1):
    (
        given_raw,
        typ,
        name,
        size_raw,
        stored_raw,
        calc_raw,
    ) = sys.stdin.buffer.readline().split()
    given = int(given_raw)
    size = int(size_raw)
    stored = int(stored_raw)
    calc = int(calc_raw)
    err = None
    if given != off:
        err = "OFFSET"
    elif stored != calc:
        err = "CHECKSUM"
    elif typ not in (b"F", b"D", b"G", b"P"):
        err = "TYPE"
    elif typ in (b"G", b"P") and pending is not None:
        err = "STATE"
    elif typ in (b"G", b"P") and size != len(name) + 1:
        err = "META_SIZE"
    elif typ in (b"G", b"P") and not ok(name):
        err = "PATH"
    elif typ in (b"F", b"D") and not ok(pending if pending is not None else name):
        err = "PATH"
    elif typ == b"D" and size:
        err = "ENTRY_SIZE"
    elif typ == b"F" and (count == limit_n or used + size > limit_b):
        err = "LIMIT"
    if err:
        print("REJECT", i, err)
        sys.exit()
    off += 512 + ((size + 511) // 512) * 512
    if typ in (b"G", b"P"):
        pending = name
    else:
        pending = None
        if typ == b"F":
            count += 1
            used += size
print("REJECT", n + 1, "STATE") if pending is not None else print(
    "ACCEPT", count, used, off
)
