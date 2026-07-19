import sys


tokens = sys.stdin.buffer.read().split()
n, k = int(tokens[0]), int(tokens[1])
ordered = sorted((fingerprint, index) for index, fingerprint in enumerate(tokens[2:n + 2], 1))
hits = 0
for left, right in zip(ordered, ordered[1:]):
    if left[0] == right[0] and right[1] - left[1] <= k:
        hits += 1
print(hits)
