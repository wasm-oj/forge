import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
b = int(next(it))
gen = used = reject = 0
family = None
out = []
for _ in range(n):
    f = next(it)
    s = int(next(it))
    if s == 0:
        out.append("CACHE")
    elif s > 8 or s > b:
        reject += 1
        out.append("REJECT")
    else:
        if family != f or used + s > b:
            gen += 1
            family = f
            used = 0
        used += s
        out.append(f"WORKER {gen}")
out.append(f"SUMMARY {gen} {reject}")
print("\n".join(out))
