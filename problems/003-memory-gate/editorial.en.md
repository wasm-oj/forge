# Editorial

## Intuitive Approach

Validate declarations and sum page counts by scanning every queried interval. This takes `O(NQ)` in the worst case; even early rejection does not help on large valid intervals.

## Optimal Approach: Prefix Sums and the Next Invalid Index

First classify every declaration independently. Build prefix sums for initial pages and effective maximum pages. Then scan from right to left to build `nextBad[i]`, the smallest invalid index at least `i`, or `N+1` if none exists.

For `[l,r]`, if `nextBad[l]≤r`, it is the required smallest invalid index. Otherwise the interval is entirely valid: obtain both page totals with prefix differences and multiply them by `65536`.

## Correctness Proof

In the reverse recurrence, set `nextBad[i]=i` when declaration `i` is invalid; otherwise copy `nextBad[i+1]`. By induction, `nextBad[i]` is exactly the first invalid index not smaller than `i`. Hence `nextBad[l]≤r` holds exactly when the query contains an invalid declaration, and the reported index is minimal. If no invalid declaration exists, every effective maximum is computed by definition, and each prefix difference equals the corresponding interval sum. Multiplication by the fixed page size yields the required byte counts. Therefore both forms of output are correct.

## Complexity

Preprocessing takes `O(N)` and each query takes `O(1)`, for total time `O(N+Q)`. Core auxiliary space is `O(N)`; including buffered I/O, the common worst-case space bound of the seven references is `O(N+Q)`. Reading the input and writing all answers already requires `Ω(N+Q)` time, so this is asymptotically optimal.

## Common Mistakes

- Treating `maximum=-1` as zero instead of the policy cap `C`.
- Forgetting to cap an explicitly declared maximum at `C`.
- Reporting an arbitrary invalid declaration rather than the smallest index.
- Storing byte totals in 32-bit integers or JavaScript `number`.
