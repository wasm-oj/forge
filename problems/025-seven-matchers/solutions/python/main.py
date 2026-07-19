import sys


def dedup_sorted(values):
    out = []
    for value in values:
        if not out or out[-1] != value:
            out.append(value)
    return out


def radix_sort(values):
    scratch = [b""] * len(values)
    for position in range(29, -1, -1):
        next_index = [0] * 257
        for value in values:
            key = value[position] + 1 if position < len(value) else 0
            next_index[key] += 1
        offset = 0
        for key, count in enumerate(next_index):
            next_index[key] = offset
            offset += count
        for value in values:
            key = value[position] + 1 if position < len(value) else 0
            scratch[next_index[key]] = value
            next_index[key] += 1
        values, scratch = scratch, values
    return values


t = iter(sys.stdin.buffer.read().split())
q = int(next(t))
out = []
for _ in range(q):
    k = next(t)
    n = int(next(t))
    m = int(next(t))
    eps = int(next(t)) if k == b"FLOAT" else 0
    a = [next(t) for _ in range(n)]
    b = [next(t) for _ in range(m)]
    if k == b"EXACT":
        ok = b"".join(a) == b"".join(b)
    elif k == b"LINES":
        while a and a[-1] == b"#":
            a.pop()
        while b and b[-1] == b"#":
            b.pop()
        ok = a == b
    elif k == b"TOKENS":
        ok = a == b
    elif k == b"FLOAT":
        ok = n == m and all(abs(int(x) - int(y)) <= eps for x, y in zip(a, b))
    else:
        a = radix_sort(a)
        b = radix_sort(b)
        if k == b"SET":
            a = dedup_sorted(a)
            b = dedup_sorted(b)
        ok = a == b
    out.append("ACCEPT" if ok else "WRONG")
print("\n".join(out))
