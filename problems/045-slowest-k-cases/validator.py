import re
import sys


def fail():
    raise SystemExit(1)


try:
    tokens = sys.stdin.buffer.read().decode("utf-8").split()
    if len(tokens) < 2 or any(re.fullmatch(r"0|[1-9][0-9]*", token) is None for token in tokens):
        fail()
    n, k = map(int, tokens[:2])
    if not 1 <= n <= 200_000 or not 1 <= k <= min(n, 5_000) or len(tokens) != n + 2:
        fail()
    if any(not 0 <= int(token) <= 10**12 for token in tokens[2:]):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
