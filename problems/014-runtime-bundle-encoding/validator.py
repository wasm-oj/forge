import re, sys


def path_ok(p):
    return (
        len(p) <= 100
        and not p.startswith("/")
        and not p.endswith("/")
        and all(
            x not in ("", ".", "..") and re.fullmatch(r"[a-z0-9._-]+", x)
            for x in p.split("/")
        )
    )


def main():
    ls = sys.stdin.read().splitlines()
    assert ls and re.fullmatch(r"[1-9][0-9]*", ls[0])
    n = int(ls[0])
    assert n <= 50000 and len(ls) == n + 1
    seen = set()
    total = 0
    for line in ls[1:]:
        x = line.split()
        assert len(x) == 3 and x[0] in ("T", "B") and path_ok(x[1]) and x[1] not in seen
        seen.add(x[1])
        p = x[2]
        if x[0] == "T":
            assert p == "-" or (
                len(p) <= 200000 and all(33 <= ord(c) <= 126 for c in p) and p != "-"
            )
        else:
            assert p == "-" or (
                len(p) % 2 == 0 and len(p) > 0 and re.fullmatch(r"[0-9a-f]+", p)
            )
        total += len(x[1]) + (0 if p == "-" else len(p) if x[0] == "T" else len(p) // 2)
    assert total <= 200000


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
