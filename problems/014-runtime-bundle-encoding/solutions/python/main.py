import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
a = [(next(it), next(it), next(it)) for _ in range(n)]
a.sort(key=lambda x: x[1])
out = ["574f424a", n.to_bytes(4, "big").hex()]
for t, path, payload in a:
    raw = (
        b""
        if payload == "-"
        else payload.encode()
        if t == "T"
        else bytes.fromhex(payload)
    )
    out.extend(
        (
            "01" if t == "T" else "02",
            len(path).to_bytes(4, "big").hex(),
            path.encode().hex(),
            len(raw).to_bytes(8, "big").hex(),
            raw.hex(),
        )
    )
print("".join(out))
