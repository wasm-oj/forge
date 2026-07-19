# Editorial

Let `L` be the maximum fingerprint length and `S` the sum of all fingerprint lengths.

## Intuitive Approach

Store every fingerprint already seen. For arrival `i`, compare its exact token with positions `1` through `i - 1` and stop at the first match. This directly implements the definition, but an all-distinct input performs `O(N^2)` comparisons. Its time is `O(N^2 L)` and its space is `O(S)`.

## Improved Approach: Sorting

Store `(fingerprint, index)` pairs and sort them by fingerprint, then by index. Equal fingerprints become one contiguous group. The first two indices of each repeated group are that fingerprint's first arrival and first duplicate. Take the group whose second index is smallest.

This takes `O(N log N * L)` time under length-bounded string comparison and `O(S)` space. It is deterministic, but sorting does more work than necessary because arrival order already tells us when an answer becomes final.

## Optimal Approach: First-Occurrence Hash Map

Scan the fingerprints from left to right and maintain a hash map from each exact token to its first index.

- If the current token is absent, insert its current index.
- If it is present, the current index is the smallest possible duplicate index because all earlier arrivals have already been checked. The stored value is the earliest matching index. Output both and stop.

Hashing may choose a bucket, but equality must still compare the complete token. Never parse fingerprints as hexadecimal integers.

## Correctness Proof

Before processing index `i`, the map contains exactly one entry for every distinct fingerprint in positions `1..i-1`, and each entry stores its earliest position. This holds initially because the prefix is empty. If fingerprint `i` is new, inserting `i` establishes the invariant for the next prefix. If it is already present, the stored index `j` is its earliest earlier occurrence by the invariant. No index smaller than `i` can be the answer because all of them were processed without finding a duplicate. Therefore the algorithm outputs exactly the required pair `(i, j)`. If the scan ends, no position duplicated an earlier token, so `NONE` is correct.

## Complexity

With expected constant-time hash-table operations, the time is `O(S)` and the space is `O(S)`. Exact comparisons resolve hash collisions, so collisions affect performance but never correctness.

## Common Mistakes

- Parsing tokens as numbers, which incorrectly makes `0` equal to `00`.
- Replacing an existing map value and then reporting the most recent occurrence instead of the first.
- Sorting and returning the lexicographically first repeated fingerprint rather than the one with the smallest duplicate index.
- Trusting equal hash values without comparing the complete fingerprint.
- Using zero-based indices in the output.
