import sys


values = list(map(int, sys.stdin.buffer.read().split()))
n, q = values[:2]
costs = values[2:2 + n]
budgets = values[2 + n:2 + n + q]

completed = 0
spent = 0
answers = []
for budget in budgets:
    while completed < n and costs[completed] <= budget - spent:
        spent += costs[completed]
        completed += 1
    answers.append(str(completed))

sys.stdout.write("\n".join(answers) + "\n")
