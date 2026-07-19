# Progressive Cost Budget

A workflow contains `N` stages in order. Stage `i` costs `cost_i` instruction-cost points. Stages cannot be skipped: completing stage `k` requires completing all preceding stages first.

You are given `Q` progressively relaxed budgets `budget_1, budget_2, ..., budget_Q`, guaranteed to be nondecreasing. Each budget independently evaluates the same workflow. For every budget, output the greatest number of consecutive stages from the beginning that can be completed. In other words, find the largest `k` such that:

```text
cost_1 + cost_2 + ... + cost_k <= budget_j
```

`k=0` is always allowed. A zero-cost stage can still be completed and must be included in the answer.

## Input

The first line contains two integers, `N Q`.

The second line contains `N` integers, `cost_1, cost_2, ..., cost_N`.

The third line contains `Q` nondecreasing integers, `budget_1, budget_2, ..., budget_Q`.

## Output

For each budget in order, output one line containing the maximum number of stages that can be completed.

## Constraints

- `1 <= N,Q <= 200000`
- `0 <= cost_i <= 10^12`
- `0 <= budget_j <= 9 * 10^18`
- `budget_1 <= budget_2 <= ... <= budget_Q`
- The sum of all stage costs is at most `9 * 10^18`
- The full constraints apply to every official test
- JavaScript and TypeScript solutions must use `bigint` for costs, budgets, and accumulated values

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 4
4 2 7 1 3
0 6 10 17
```

Output:

```text
0
2
2
5
```

### Example Two

Input:

```text
4 5
0 5 0 2
0 4 5 6 7
```

Output:

```text
1
1
3
3
4
```

### Example Three

Input:

```text
1 3
9
8 9 100
```

Output:

```text
0
1
1
```

<!-- END GENERATED SAMPLES -->
