import sys


def input_tokens():
    for line in sys.stdin.buffer:
        yield from line.split()


tokens = input_tokens()
n, k = int(next(tokens)), int(next(tokens))
last_index = {}
hits = 0
for index in range(1, n + 1):
    fingerprint = next(tokens)
    previous = last_index.get(fingerprint)
    if previous is not None and index - previous <= k:
        hits += 1
    last_index[fingerprint] = index
print(hits)
