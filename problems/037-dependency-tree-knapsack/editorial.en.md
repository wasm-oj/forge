# Editorial

## Intuitive Approach

Enumerating all subsets and validating every selected node's ancestors takes `O(2^N N)` time. A conventional tree knapsack that convolves a capacity table for every child takes `O(NC^2)` in the worst case.

## Optimal Approach: Preorder and Skip-Subtree DP

Attach every forest root to a virtual node `0` that is always selected and has zero size and value. Run DFS preorder over the real nodes, producing `order[0..N-1]`. For every preorder position `i`, record `after[i]`, the first position after the entire subtree rooted at `order[i]`.

Define `dp[i][c]` as the maximum value obtainable from preorder position `i` onward with capacity `c`, under the precondition that the parent of `order[i]` has been selected. Let `u = order[i]`. There are two choices:

- Skip `u`: dependency closure forbids every descendant of `u`, so continue at `dp[after[i]][c]`.
- Select `u`: pay its size, gain its value, and continue at the next preorder position.

```text
dp[i][c] = max(dp[after[i]][c], value[u] + dp[i + 1][c - size[u]])
```

The second term exists only when `size[u] <= c`. Compute positions from `N - 1` down to `0`; the answer is `dp[0][C]`.

## Correctness Proof

Consider state `(i, c)` and node `u`, whose parent is selected by the state invariant. Every dependency-closed solution falls into exactly one of two cases. If it omits `u`, it must omit every descendant, and preorder continuation is exactly `after[i]`. If it includes `u`, closure is satisfied at `u`; after paying for it, the next preorder position may be decided under the same ancestor preconditions. The cases are disjoint and exhaustive, and each transition uses the optimal remainder for its case.

Backward induction therefore proves every `dp[i][c]` correct. The virtual root makes each forest root independently selectable or skippable, so `dp[0][C]` is the optimum over the entire forest.

## Complexity

DFS takes `O(N)` time. There are `N(C + 1)` constant-time DP states, so both time and space are `O(NC)`, improving on the `O(NC^2)` child-convolution approach.

## Common Mistakes

- Reversing the dependency: selecting a parent does not require selecting every child.
- Advancing only to `i + 1` after skipping a node, which permits descendants without their prerequisite.
- Assuming the input IDs already form a DFS preorder.
- Forgetting the virtual-root semantics needed to combine independent trees.
