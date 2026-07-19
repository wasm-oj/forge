# Editorial

## Intuitive Approach

Scanning `[L,R]` for every query takes `O(NQ)` time in the worst case. An intermediate method stores sorted positions for each verdict and uses two binary searches per query, improving the total to `O(N + Q log N)`.

## Optimal Approach: Four Prefix Counts

Let `pref[v][i]` be the number of verdict `v` values among the first `i` positions. Build the table from left to right by copying the previous column and incrementing the current verdict. A query is:

```text
pref[V][R] - pref[V][L - 1]
```

The fixed four-verdict alphabet maps directly to a four-element array; a general dictionary is unnecessary.

## Correctness Proof

By definition, `pref[V][R]` counts every `V` in positions `1..R`, while `pref[V][L-1]` counts exactly those left of the query in positions `1..L-1`. Their difference contains precisely `[L,R]`, with no omitted or repeated position. Construction adds each position's verdict exactly once, so the prefix definition holds everywhere.

## Complexity

Building takes `O(N)`, and each query takes `O(1)`, for `O(N+Q)` total time. The four prefix arrays and input/output buffers have a common `O(N+Q)` space bound.

## Common Mistakes

- Using `pref[R] - pref[L]` for a closed interval.
- Mixing zero-based and one-based indices.
- Reallocating or copying the verdict string for every query.
- Mapping an unvalidated query character to a valid verdict accidentally.
