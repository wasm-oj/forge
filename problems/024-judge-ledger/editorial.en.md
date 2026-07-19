# Editorial

## Intuitive Approach

Scan cases for every query, stopping early for fail-fast, while accumulating sums and maxima. One query costs `O(N)`, for `O(NQ)` total time.

## Optimal Approach: Prefix Data and Iterative Segment Trees

Precompute `nextBad[i]` from right to left: the first non-AC position at or after `i`, or `N+1` if none exists. This determines the actual right endpoint and verdict in `O(1)`.

For both cost and time, build a prefix sum of known values and a prefix count of `-1` values. Output the interval sum only when its unknown count is zero. Memory and VFS also use unknown-count prefixes; when known, query their interval maxima using iterative segment trees.

## Correctness Proof

By definition, `nextBad[l]` is the only possible fail-fast stopping point, so the chosen right endpoint and first-failure verdict are correct. Prefix differences cover exactly the selected interval. A positive unknown count is equivalent to the statement's `null` condition; otherwise the prefix difference is the required sum. Each segment-tree query partitions the interval into disjoint nodes, whose maximum equals the maximum over all cases. Therefore all six output fields are correct.

## Complexity

Preprocessing takes `O(N)`. Each query performs two range-maximum queries in `O(log N)`, for total time `O(N+Q log N)`. The prefix data and segment trees use `O(N)` auxiliary space; because several reference implementations also retain the input and buffer all answers, their total resident space is `O(N+Q)`. This is the practical reference path shared by all seven languages. A theoretical static-RMQ solution could combine a Cartesian tree with linear-preprocessing RMQ for `O(N+Q)` total time, but that is not the implementation claimed by the reference solutions.

## Common Mistakes

- Excluding the failing case from a fail-fast range.
- Turning every metric into `null` when only one metric is unknown.
- Using an identity other than 0 for maxima, or introducing an endpoint off-by-one.
- Reporting the last failure rather than the first in a non-fail-fast query.
