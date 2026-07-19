# Editorial

## Intuitive Approach

Enumerating all bundle subsets takes `O(2^N N)` time. A three-dimensional table `dp[item][bytes][entries]` solves the problem in `O(NBI)` time but uses `O(NBI)` space, exceeding 64 MiB at the full limits.

## Optimal Approach: Two-Dimensional 0/1 Knapsack

Let `dp[e][b]` be the maximum value obtainable from the bundles processed so far using at most `e` entries and at most `b` bytes. For a bundle `(w, k, v)`, iterate `e` downward from `I` to `k` and `b` downward from `B` to `w`:

```text
dp[e][b] = max(dp[e][b], dp[e - k][b - w] + v)
```

Both dimensions descend, so the source state belongs to the state before the current bundle was added. Each bundle is therefore used at most once. The answer is `dp[I][B]`.

When the quota ranges are huge but reachable states are sparse, a Pareto frontier may be useful. Under this problem's explicit capacity bounds, dense DP provides a simpler deterministic worst-case bound.

## Correctness Proof

Induct on the number of processed bundles. Any optimal solution for quotas `(e, b)` either excludes the new bundle, preserving old `dp[e][b]`, or includes it. Removing it from the second case leaves a legal solution for `(e - k, b - w)`, whose best old value plus `v` is exactly the transition candidate. These cases are exhaustive and disjoint, so their maximum is correct.

Descending iteration in both quota dimensions prevents the new bundle from appearing in a source state during the same iteration, preserving the 0/1 restriction even when `w = 0`. Thus final `dp[I][B]` is the maximum legal importance.

## Complexity

Time is `O(NBI)`, and space is `O(BI)`.

## Common Mistakes

- Solving only a one-dimensional bytes knapsack and ignoring the entry quota.
- Updating the entry dimension upward; with `bytes = 0`, this can reuse the same bundle in one iteration. Descend in both dimensions.
- Skipping zero-byte bundles even though they can have value and still consume entries.
- Optimizing the two quotas separately and intersecting the chosen sets, which need not be globally optimal.
