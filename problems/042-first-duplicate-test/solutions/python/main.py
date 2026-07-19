import sys


def input_tokens():
    for line in sys.stdin.buffer:
        yield from line.split()


tokens = input_tokens()
n = int(next(tokens))
first_index = {}
for index in range(1, n + 1):
    fingerprint = next(tokens)
    earliest = first_index.get(fingerprint)
    if earliest is not None:
        print(index, earliest)
        break
    first_index[fingerprint] = index
else:
    print("NONE")
