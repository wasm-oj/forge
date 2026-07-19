import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
a = []
for _ in range(n):
    row = (next(it), next(it), next(it))
    j = len(a)
    while j and a[j - 1][1] > row[1]:
        j -= 1
    a.insert(j, row)
out = bytearray(b"WOBJ") + n.to_bytes(4, "big")
for t, path, payload in a:
    raw = (
        b""
        if payload == "-"
        else payload.encode()
        if t == "T"
        else bytes.fromhex(payload)
    )
    out += (
        bytes([1 if t == "T" else 2])
        + len(path).to_bytes(4, "big")
        + path.encode()
        + len(raw).to_bytes(8, "big")
        + raw
    )
print(out.hex())
