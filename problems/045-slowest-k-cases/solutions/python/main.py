import heapq
import sys


tokens = sys.stdin.buffer.read().split()
n = int(tokens[0])
k = int(tokens[1])
heap: list[tuple[int, int]] = []
output = []

for index in range(1, n + 1):
    cost = int(tokens[index + 1])
    candidate = (cost, -index)
    if len(heap) < k:
        heapq.heappush(heap, candidate)
    elif candidate > heap[0]:
        heapq.heapreplace(heap, candidate)
    if index >= k:
        output.append(f"{-heap[0][1]} {heap[0][0]}\n")

sys.stdout.write("".join(output))
