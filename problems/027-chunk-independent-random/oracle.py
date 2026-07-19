#!/usr/bin/env python3
import sys

MASK = (1 << 64) - 1
startup_seed, user_seed, startup_size, query_count = map(
    int, sys.stdin.readline().split()
)
lengths = list(map(int, sys.stdin.readline().split()))


def stream(seed):
    counter = 1
    while True:
        word = (seed + 0x9E3779B97F4A7C15 * counter) & MASK
        word = ((word ^ (word >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        word = ((word ^ (word >> 27)) * 0x94D049BB133111EB) & MASK
        word ^= word >> 31
        for shift in range(0, 64, 8):
            yield (word >> shift) & 255
        counter += 1


startup = stream(startup_seed)
user = stream(user_seed)
position = 0

for length in lengths:
    first = last = None
    for _ in range(length):
        last = next(startup) if position < startup_size else next(user)
        if first is None:
            first = last
        position += 1
    print(first, last)
