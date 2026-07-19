# Editorial

## Intuitive Approach

Enumerating whether to keep each artifact takes `O(2^N N)` time. A standard two-dimensional table `dp[i][c]` reduces the time to `O(NC)`, but its `O(NC)` memory exceeds the full memory limit.

## Optimal Approach: One-Dimensional 0/1 Knapsack

Let `dp[c]` be the maximum value obtainable from the artifacts processed so far with total size at most `c`. Initially all entries are zero, representing the empty subset.

For an artifact `(w, v)`, iterate `c` downward from `C` to `w` and apply

```text
dp[c] = max(dp[c], dp[c - w] + v)
```

Descending capacity ensures that the source state still belongs to the previous artifact set, so the current artifact cannot be used more than once. The answer is `dp[C]`.

## Correctness Proof

Induct on the number of processed artifacts. Initially, only the empty subset is available and every `dp[c] = 0` is correct. For a new artifact `(w, v)`, an optimal subset for capacity `c` either excludes it, retaining the old `dp[c]`, or includes it, in which case the remaining artifacts occupy at most `c - w` and contribute at most the old `dp[c - w]`. The transition takes the better of exactly these two exhaustive, disjoint cases.

Because capacities are updated in descending order, every source on the right excludes the current artifact. Thus the 0/1 restriction is preserved, the invariant holds after each artifact, and `dp[C]` is the optimum.

## Complexity

The algorithm uses `O(NC)` time and `O(C)` space. This is the standard pseudo-polynomial optimization for 0/1 knapsack; the general binary-encoded problem is NP-hard.

## Common Mistakes

- Iterating capacity upward and turning the problem into unbounded knapsack.
- Applying a value-to-size greedy rule, which is not valid for 0/1 knapsack.
- Mishandling `C = 0` or zero-valued artifacts.
- Accumulating values in a 32-bit integer.
