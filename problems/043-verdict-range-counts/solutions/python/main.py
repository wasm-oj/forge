import sys


tokens = sys.stdin.buffer.read().split()
n, q = map(int, tokens[:2])
verdicts = tokens[2]
mapping = {ord("A"): 0, ord("W"): 1, ord("R"): 2, ord("T"): 3}
prefix = [[0] * (n + 1) for _ in range(4)]
for index, verdict in enumerate(verdicts, 1):
    for kind in range(4):
        prefix[kind][index] = prefix[kind][index - 1]
    prefix[mapping[verdict]][index] += 1
output = []
cursor = 3
for _ in range(q):
    left, right = int(tokens[cursor]), int(tokens[cursor + 1])
    kind = mapping[tokens[cursor + 2][0]]
    cursor += 3
    output.append(str(prefix[kind][right] - prefix[kind][left - 1]))
sys.stdout.write("\n".join(output) + "\n")
