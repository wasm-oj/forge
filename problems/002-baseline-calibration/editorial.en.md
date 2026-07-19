# Editorial

## Intuitive Approach

For each query, filter the observations belonging to that profile and check all `S` seeds and costs. This takes `O(NQ)` time. Sorting by `(profile,seed)` once and grouping observations improves the bound to `O(N log N+Q)`.

## Optimal Approach: Per-Profile Aggregation

Because `(profile,seed)` pairs are guaranteed to be unique, keep only three values per profile: its observation `count`, `minCost`, and `maxCost`. Update them as each observation is read. A profile is valid if and only if `count=S` and `minCost=maxCost`; the common cost is its baseline.

## Correctness Proof

If the algorithm declares a profile valid, it has `S` distinct observed seeds. Every seed lies in the `S`-element set `1..S`, so every required seed appears exactly once. Moreover, `minCost=maxCost` means all observed costs are identical. Thus the publication requirements hold. Conversely, every publishable profile has all `S` observations and identical costs, so it passes both tests. For a valid query, the algorithm then outputs the common cost and `max(0,raw-baseline)`, exactly as defined.

## Complexity

Initialization, aggregation, and queries take `O(P)`, `O(N)`, and `O(Q)` time, respectively, for `O(P+N+Q)` total time. Core auxiliary space is `O(P)`. With buffered input/output allocations included, the common worst-case bound of the seven reference implementations is `O(P+N+Q)`. Reading all data already gives an `Ω(P+N+Q)` worst-case lower bound, so the running time is asymptotically optimal.

## Common Mistakes

- Comparing costs without verifying that every seed is present.
- Dividing the total by the count; an equal average does not mean all observations are equal.
- Subtracting `raw-baseline` directly in an unsigned type and underflowing.
- Assuming observations are ordered by profile or seed.
