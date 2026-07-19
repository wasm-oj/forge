# Editorial

Let `L` be the maximum fingerprint length, `S` the total input fingerprint length, and `U` the number of distinct fingerprints.

## Intuitive Approach

For each submission `i`, compare its exact token with the previous at most `K` submissions. Stop after the first match. This uses `O(N K L)` time in the worst case and `O(K L)` auxiliary space if the recent tokens are kept in a queue. It is simple, but too slow when both `N` and `K` are large.

## Improved Approach: Balanced Search Tree

Maintain the most recent index for every fingerprint in an ordered map. A lookup and update take `O(log U)` ordered string comparisons, each costing up to `O(L)`. Submission `i` is a hit exactly when the stored index is at least `i - K`. This gives `O(N log N * L)` time and `O(U L)` space.

## Optimal Approach: Last-Position Hash Map

The full recent window need not be stored. For each fingerprint, only its latest previous position can matter: if that position is older than `i - K`, every earlier equal position is older too.

Scan from left to right. Let `last[f]` be the most recent index with fingerprint `f`.

1. If `f` is in the map and `i - last[f] <= K`, count one hit.
2. Set `last[f] = i`, whether this submission was a hit or a miss.

For `K = 0`, every positive index difference exceeds `K`, so the same rule correctly counts no hits.

## Correctness Proof

Immediately before processing index `i`, `last[f]` is the greatest index smaller than `i` whose fingerprint is `f`, if one exists. The invariant is true before the first submission and remains true because the algorithm assigns `last[f] = i` after processing `i` without changing other entries.

If `i - last[f] <= K`, that latest occurrence lies in `[max(1, i-K), i-1]`, so submission `i` is a hit. If the latest occurrence is absent or farther than `K`, every earlier occurrence has an even larger distance and none lies in the interval, so it is a miss. Thus each submission is classified exactly as defined, and their accumulated count is correct.

## Complexity

With expected constant-time hash-table operations, processing and hashing all tokens takes expected `O(S)` time. The algorithmic core retains only `U` distinct tokens and their last positions, using `O(U L)` space; input buffering or an `N`-sized hash-table reservation in the seven references gives a common resident bound of `O(S)`. Exact token comparison resolves hash collisions.

## Common Mistakes

- Treating the window as `[i-K, i]` and letting a submission match itself.
- Using `< K` rather than `<= K`; a matching submission exactly `K` positions earlier is included.
- Counting all matching positions in the window rather than one hit for the current submission.
- Updating the last position before testing it, which makes every submission match itself.
- Special-casing `K = 0` incorrectly or parsing tokens as numbers.
