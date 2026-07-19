import re
import sys


def fail():
    raise SystemExit(1)


try:
    tokens = sys.stdin.buffer.read().decode("utf-8").split()
    position = 0

    def unsigned(lower, upper):
        global position
        if position >= len(tokens) or re.fullmatch(r"0|[1-9][0-9]*", tokens[position]) is None:
            fail()
        value = int(tokens[position])
        position += 1
        if not lower <= value <= upper:
            fail()
        return value

    n = unsigned(1, 200000)
    q = unsigned(1, 200000)
    total = 0
    for _ in range(n):
        total += unsigned(0, 10**12)
        if total > 9 * 10**18:
            fail()

    previous = -1
    for _ in range(q):
        budget = unsigned(0, 9 * 10**18)
        if budget < previous:
            fail()
        previous = budget

    if position != len(tokens):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
