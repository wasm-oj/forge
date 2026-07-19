import sys

lines = sys.stdin.buffer.read().decode().splitlines()
out = []
for path in lines[1:]:
    seg = path.split("/")
    removed = [False] * len(seg)
    bad = False
    for i, x in enumerate(seg):
        if x in ("", "."):
            removed[i] = True
        elif x == "..":
            removed[i] = True
            j = i - 1
            while j >= 0 and removed[j]:
                j -= 1
            if j < 0:
                bad = True
                break
            removed[j] = True
    out.append(
        "INVALID"
        if bad
        else "/" + ("/".join(x for i, x in enumerate(seg) if not removed[i]))
    )
print("\n".join(out))
