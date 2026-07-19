import re
import sys


def fail():
    raise SystemExit(1)


try:
    tokens = sys.stdin.buffer.read().decode("utf-8").split()
    integer = re.compile(r"0|[1-9][0-9]*")
    if len(tokens) < 2 or integer.fullmatch(tokens[0]) is None or integer.fullmatch(tokens[1]) is None:
        fail()
    n, k = int(tokens[0]), int(tokens[1])
    if not 1 <= n <= 200_000 or not 0 <= k <= n or len(tokens) != n + 2:
        fail()
    fingerprint = re.compile(r"[0-9a-f]{1,32}")
    if any(fingerprint.fullmatch(token) is None for token in tokens[2:]):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
