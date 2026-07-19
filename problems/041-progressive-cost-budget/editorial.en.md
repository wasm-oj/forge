# Editorial

## Intuitive Approach: Restart Every Scan

For each budget, start at the first stage and accumulate costs until the next stage would exceed the budget. One query can inspect all `N` stages, so the total time is `O(NQ)`. Because the budgets appear after the costs in the input, retaining the costs takes `O(N)` space. This directly follows the definition, but it cannot finish when `N,Q=200000`.

## Efficient Approach: Prefix Sums and Binary Search

Build a prefix-sum array:

```text
prefix[0] = 0
prefix[k] = cost_1 + cost_2 + ... + cost_k
```

All costs are nonnegative, so `prefix` is nondecreasing. For a budget `B`, find the last position in `prefix` whose value is at most `B`; that position is the answer. Use upper bound—the first value greater than `B`—rather than an arbitrary matching position. Zero-cost stages can create equal prefix sums, and stopping at an earlier equal value would miss stages that are free to complete.

Building the array takes `O(N)`. Each binary search takes `O(log N)`, for `O(N+Q log N)` total time and `O(N)` auxiliary space.

## Optimal Approach: Two Pointers over Monotone Budgets

The budgets are nondecreasing, so the answer for one query can never shrink for the next query. Maintain:

- `completed`, the number of stages currently completed;
- `spent`, the total cost of those stages.

For the current budget `B`, repeatedly complete the next stage while it exists and `cost[completed] <= B - spent`. Comparing with the remaining budget avoids a potentially overflowing `spent + cost` expression. Output `completed` when the loop stops.

## Correctness Proof

Before each budget is processed, maintain the invariant that `completed` is the maximum prefix allowed by the previous budget and `spent` is exactly that prefix's cost.

The current budget is no smaller than the previous one, so the existing prefix remains valid. Every loop iteration adds the next stage only when it is affordable, hence the enlarged prefix remains valid; zero-cost stages are covered by the same test. The loop stops only after every stage is complete or when the next stage would exceed the current budget. In the latter case, no longer prefix can be valid because stages cannot be skipped. Therefore `completed` is exactly the maximum valid answer for the current budget, and the invariant holds for the next query. By induction, every reported answer is correct.

## Complexity

Every budget is handled once, and `completed` advances from `0` to `N` at most once over the whole algorithm. Total time is `O(N+Q)`, and storing the stage costs takes `O(N)` auxiliary space. Some reference implementations buffer `Q` output lines to reduce output calls, making their resident space `O(N+Q)`.

## Common Mistakes

- Resetting the stage pointer for each budget, which degrades to `O(NQ)`.
- Failing to advance over zero-cost stages.
- Using lower bound in the binary-search approach and missing later equal prefix sums.
- Assuming budgets are strictly increasing; adjacent budgets may be equal.
- Using 32-bit integers, or imprecise JavaScript/TypeScript `number` values.
