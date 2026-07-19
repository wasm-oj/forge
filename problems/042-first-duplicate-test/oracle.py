import sys


tokens = sys.stdin.buffer.read().split()
n = int(tokens[0])
ordered = sorted((fingerprint, index) for index, fingerprint in enumerate(tokens[1:n + 1], 1))
answer = None
start = 0
while start < n:
    end = start + 1
    while end < n and ordered[end][0] == ordered[start][0]:
        end += 1
    if end - start >= 2:
        candidate = (ordered[start + 1][1], ordered[start][1])
        if answer is None or candidate[0] < answer[0]:
            answer = candidate
    start = end

if answer is None:
    print("NONE")
else:
    print(*answer)
