# Editorial

## Intuitive Approach

Each group contributes either no plan or one of `K_g` plans, yielding `product(K_g + 1)` combinations. A two-dimensional `dp[g][c]` reduces time to `O(C sum K_g)` but consumes `O(GC)` space, exceeding the full memory limit.

## Optimal Approach: Rolling Multiple-Choice Knapsack

Let `dp[c]` be the maximum confidence obtainable from processed profiles with total time at most `c`. When processing one profile, initialize `next = dp` to represent skipping it. Then, for every plan `(time, value)` in that profile and every `c >= time`, update

```text
next[c] = max(next[c], dp[c - time] + value)
```

Every source must come from the previous profile's `dp`, not from `next`. Replace `dp` with `next` only after the entire profile is processed. This enforces mutual exclusion even for plans with zero execution time.

## Correctness Proof

Induct on the number of processed profiles. For a new profile, every legal schedule either skips it, which is represented by retaining old `dp[c]`, or selects exactly one of its plans. Removing that selected plan leaves a schedule using only earlier profiles, whose best value is old `dp[c - time_j]`; adding the plan contributes `value_j`. The transition examines every mutually exclusive choice and takes the best.

Since no transition reads from `next`, no state can contain two plans from the same profile. Therefore the invariant holds after each group, and final `dp[C]` is the best valid schedule.

## Complexity

Every plan scans `C + 1` capacities, so time is `O(C sum K_g)`. Two one-dimensional arrays use `O(C)` space.

## Common Mistakes

- Flattening all plans into ordinary 0/1 knapsack and selecting multiple plans from one profile.
- Transitioning from `next`, especially when `time = 0`.
- Requiring one plan from every profile even though skipping is allowed.
- Storing accumulated confidence in a 32-bit integer.
