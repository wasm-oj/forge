import sys

it = iter(sys.stdin.read().split())
n = int(next(it))
b = int(next(it))
history = []
reject = 0
out = []
for _ in range(n):
    f = next(it)
    s = int(next(it))
    if s == 0:
        out.append("CACHE")
        continue
    if s > 8 or s > b:
        reject += 1
        out.append("REJECT")
        continue
    generation = 0
    family = None
    used = 0
    for pf, ps, accepted in history:
        if not accepted or ps == 0:
            continue
        if family != pf or used + ps > b:
            generation += 1
            family = pf
            used = 0
        used += ps
    if family != f or used + s > b:
        generation += 1
    out.append(f"WORKER {generation}")
    history.append((f, s, True))
print("\n".join(out))
print(
    "SUMMARY",
    max([0] + [int(x.split()[1]) for x in out if x.startswith("WORKER")]),
    reject,
)
