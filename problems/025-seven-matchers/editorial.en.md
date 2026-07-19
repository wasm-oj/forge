# Editorial

## Intuitive Approach

For `SET`, `MULTISET`, and `FILESET`, linearly search the actual array for each expected token and mark matches as used. This costs `O(K^2)` in the worst case and cannot handle a total of 200,000 tokens.

## Advanced Approach: Canonical Comparison Sorting

Sort both sides of every unordered matcher with a comparison sort, then compare linearly. This is deterministic and easy to implement, but performs `O(K log K)` comparisons. Even with short tokens, its worst-case time is `O(K log K+L)` and does not exploit the stated bounds on token length and byte alphabet.

## Optimal Approach: Bounded-Byte Stable LSD Radix Sort

`EXACT` concatenation, `LINES` trailing removal, `TOKENS`, and `FLOAT` are all linear.

Ordinary tokens are at most 30 bytes, and `FILESET` entries at most 29. For each unordered matcher, establish canonical order with 30 passes of stable LSD byte counting sort. Process positions 29 down to 0. Use key 0 when the position is absent and `byte+1` when present. Each pass uses a 257-entry counting table. The missing sentinel is less than every real byte, so a prefix string sorts before a longer string with the same prefix; the resulting order is bytewise lexicographic.

After sorting, deduplicate `SET` linearly before comparing the sides. Compare the sorted arrays directly for `MULTISET` and `FILESET`. The method has no hash collisions, language-specific hash behavior, or comparison-sort dependency.

For `FLOAT`, the maximum possible difference is `2×10^18`, still within the stated signed 64-bit range. JavaScript and TypeScript should use `bigint`.

## Correctness Proof

`EXACT`, `LINES`, and `TOKENS` implement their specified normalization and element comparison directly. `FLOAT` checks the necessary and sufficient condition at every position.

For radix sorting, assume inductively before position `p` that the sequence is sorted by suffix positions `p+1..29`. The counting pass groups records by their position-`p` key and, because it is stable, preserves suffix order among equal keys. The sequence is then sorted by positions `p..29`. Repeating from position 29 to 0 yields order by the complete 30-position key. Missing has key 0 while every real byte has key `byte+1`, so this is exactly bytewise lexicographic order.

Radix sorting only permutes elements and preserves multiplicities. Therefore two sorted sequences are equal exactly when their multisets are equal. Removing adjacent duplicates produces equal sequences exactly when their sets are equal. In `FILESET`, each side has unique paths, so comparing complete-entry multisets is equivalent to comparing file mappings. Thus every matcher returns the correct result.

## Complexity

Let `K` be the total number of tokens on both sides of all queries, `L` their total character length, and `K_q,L_q` the corresponding values for one query. Maximum token length is constant `B=30`, and alphabet size is `A=257`. One radix canonicalization costs `O(BK_q+AB+L_q)`, which is `O(1+K_q+L_q)` because `B,A` are fixed and tokens are nonempty. Including `Q` headers, empty queries, and one output line per query, total time across all matchers is `O(Q+K+L)`.

Per-query auxiliary space is `O(K_max+L_max)`, with `O(K_max+A)` radix scratch space. C, C++, and Go can stream by query. Rust, Python, JavaScript, and TypeScript references retain full input and buffer `Q` output lines, so their actual buffered-I/O resident space is `O(Q+K+L)`.

## Common Mistakes

- Inserting spaces between tokens for `EXACT`.
- Removing empty lines from the middle for `LINES`.
- Forgetting to deduplicate `SET`, or incorrectly deduplicating `MULTISET`.
- Using floating point for `FLOAT`, or overflowing during subtraction.
- Using comparison sort and obtaining `O(K log K+L)` rather than deterministic `O(K+L)`.
