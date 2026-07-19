import sys

lines = sys.stdin.buffer.read().split()
out = []
for path in lines[1:]:
    st = []
    bad = False
    for x in path.split(b"/"):
        if not x or x == b".":
            continue
        if x == b"..":
            if not st:
                bad = True
                break
            st.pop()
        else:
            st.append(x)
    out.append(b"INVALID" if bad else b"/" + b"/".join(st))
sys.stdout.buffer.write(b"\n".join(out) + b"\n")
