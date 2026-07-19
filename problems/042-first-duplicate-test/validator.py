import re
import sys


def fail():
    raise SystemExit(1)


try:
    tokens = sys.stdin.buffer.read().decode("utf-8").split()
    if not tokens or re.fullmatch(r"[1-9][0-9]*", tokens[0]) is None:
        fail()
    n = int(tokens[0])
    if not 1 <= n <= 200_000 or len(tokens) != n + 1:
        fail()
    fingerprint = re.compile(r"[0-9a-f]{1,32}")
    if any(fingerprint.fullmatch(token) is None for token in tokens[1:]):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
