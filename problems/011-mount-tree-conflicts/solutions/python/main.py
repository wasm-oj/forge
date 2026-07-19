import sys
from array import array


tokens = sys.stdin.buffer.read().split()
n = int(tokens[0])
infinity = n + 1
first_child = array("i", [0])
next_sibling = array("i", [0])
exact_min = array("i", [infinity])
file_min = array("i", [infinity])
desc_min = array("i", [infinity])
node_char = bytearray(1)


def find_or_create_child(parent, char):
    child = first_child[parent]
    while child:
        if node_char[child] == char:
            return child
        child = next_sibling[child]
    child = len(node_char)
    first_child.append(0)
    next_sibling.append(first_child[parent])
    exact_min.append(infinity)
    file_min.append(infinity)
    desc_min.append(infinity)
    node_char.append(char)
    first_child[parent] = child
    return child


token_at = 1
for j in range(1, n + 1):
    kind = tokens[token_at]
    path = tokens[token_at + 1]
    token_at += 2
    visited = []
    current = 0
    best = infinity

    for position, char in enumerate(path):
        current = find_or_create_child(current, char)
        visited.append(current)
        if position + 1 < len(path) and (
            position == 0 or path[position + 1] == ord("/")
        ):
            best = min(best, file_min[current])
    best = min(best, exact_min[current])
    if kind == b"F":
        best = min(best, desc_min[current])

    if best != infinity:
        print("CONFLICT", best, j)
        raise SystemExit

    for position in range(len(path) - 1):
        if position == 0 or path[position + 1] == ord("/"):
            at = visited[position]
            desc_min[at] = min(desc_min[at], j)
    exact_min[current] = min(exact_min[current], j)
    if kind == b"F":
        file_min[current] = min(file_min[current], j)

print("VALID")
