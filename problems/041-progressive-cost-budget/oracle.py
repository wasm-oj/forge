from bisect import bisect_right
import sys


values = list(map(int, sys.stdin.buffer.read().split()))
n, q = values[:2]
costs = values[2:2 + n]
budgets = values[2 + n:2 + n + q]

prefix = [0]
for cost in costs:
    prefix.append(prefix[-1] + cost)

answers = (str(bisect_right(prefix, budget) - 1) for budget in budgets)
sys.stdout.write("\n".join(answers) + "\n")
