# Editorial

## Intuitive Approach

Repeatedly search all remaining items for the next one in policy order, taking `O(N^2)` time. Knapsack or size-based selection is incorrect because the statement mandates one unique policy order.

## Optimal Approach: Sort Once and Take a Prefix

Compute `T` and `need`. If `need>T`, output `IMPOSSIBLE`. Otherwise sort by `(priority,lastUsed,participant,key)` and accumulate item sizes from the front until the total first reaches `need`.

## Correctness Proof

After sorting, item `i` is exactly the next item selected by policy after items `1` through `i-1` have been removed. Therefore the algorithm's sequence is identical to the policy's step-by-step sequence. Before stopping, the freed total is below `need`; after including the last item, it is at least `need`. Hence the algorithm also stops at exactly the first point required by policy.

## Complexity

Sorting takes `O(N log N)`, scanning takes `O(N)`, and space is `O(N)`. In a comparison model with arbitrary participant and key strings, emitting the complete policy order can encode a sort, so this is asymptotically optimal.

## Common Mistakes

- Using only `T-C` and omitting the browser reserve deficit.
- Evicting higher-priority items first.
- Using locale-aware string ordering instead of ASCII byte order.
- Partially deleting the last item when it exceeds the remaining need.
