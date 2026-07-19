import bisect
import sys


tokens = sys.stdin.buffer.read().split()
n, q = map(int, tokens[:2])
verdicts = tokens[2].decode()
positions = {value: [] for value in "AWRT"}
for index, value in enumerate(verdicts, 1):
    positions[value].append(index)
output = []
cursor = 3
for _ in range(q):
    left, right = int(tokens[cursor]), int(tokens[cursor + 1])
    verdict = tokens[cursor + 2].decode()
    cursor += 3
    locations = positions[verdict]
    output.append(str(bisect.bisect_right(locations, right) - bisect.bisect_left(locations, left)))
print("\n".join(output))
