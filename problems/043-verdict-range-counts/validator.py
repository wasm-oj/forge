import re
import sys


def fail():
    raise SystemExit(1)


try:
    tokens = sys.stdin.buffer.read().decode("utf-8").split()
    position = 0

    def unsigned(minimum, maximum):
        global position
        if position >= len(tokens) or re.fullmatch(r"0|[1-9][0-9]*", tokens[position]) is None:
            fail()
        value = int(tokens[position])
        position += 1
        if not minimum <= value <= maximum:
            fail()
        return value

    n, q = unsigned(1, 200_000), unsigned(1, 200_000)
    if position >= len(tokens):
        fail()
    verdicts = tokens[position]
    position += 1
    if len(verdicts) != n or any(value not in "AWRT" for value in verdicts):
        fail()
    for _ in range(q):
        left, right = unsigned(1, n), unsigned(1, n)
        if left > right or position >= len(tokens) or tokens[position] not in {"A", "W", "R", "T"}:
            fail()
        position += 1
    if position != len(tokens):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
