import sys


tokens = list(map(int, sys.stdin.buffer.read().split()))
n, k = tokens[:2]
costs = tokens[2:]

order = sorted(range(n), key=lambda index: (-costs[index], index))
rank = [0] * n
for position, index in enumerate(order, 1):
    rank[index] = position

fenwick = [0] * (n + 1)


def add(position: int) -> None:
    while position <= n:
        fenwick[position] += 1
        position += position & -position


def kth(target: int) -> int:
    position = 0
    step = 1 << (n.bit_length() - 1)
    while step:
        candidate = position + step
        if candidate <= n and fenwick[candidate] < target:
            target -= fenwick[candidate]
            position = candidate
        step >>= 1
    return position + 1


output = []
for index in range(n):
    add(rank[index])
    if index + 1 >= k:
        answer = order[kth(k) - 1]
        output.append(f"{answer + 1} {costs[answer]}\n")
sys.stdout.write("".join(output))
