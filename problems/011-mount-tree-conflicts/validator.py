import re, sys


def ok_path(p: str) -> bool:
    if p == "/":
        return True
    if not p.startswith("/") or p.endswith("/") or len(p) > 200:
        return False
    return all(
        x not in ("", ".", "..") and re.fullmatch(r"[a-z0-9._-]+", x)
        for x in p[1:].split("/")
    )


def main() -> None:
    lines = sys.stdin.read().splitlines()
    assert lines and re.fullmatch(r"[1-9][0-9]*", lines[0])
    n = int(lines[0])
    assert n <= 200000 and len(lines) == n + 1
    total = 0
    for line in lines[1:]:
        parts = line.split()
        assert len(parts) == 2 and parts[0] in ("F", "D") and ok_path(parts[1])
        total += len(parts[1].encode())
    assert total <= 2000000


try:
    main()
except (AssertionError, ValueError):
    sys.exit(1)
