import sys


def anc(a, b):
    return a == "/" and b != "/" or b.startswith(a + "/")


data = sys.stdin.read().split()
n = int(data[0])
rows = [(data[i], data[i + 1]) for i in range(1, 2 * n + 1, 2)]
for j in range(n):
    for i in range(j):
        ki, pi = rows[i]
        kj, pj = rows[j]
        if pi == pj or (ki == "F" and anc(pi, pj)) or (kj == "F" and anc(pj, pi)):
            print("CONFLICT", i + 1, j + 1)
            raise SystemExit
print("VALID")
