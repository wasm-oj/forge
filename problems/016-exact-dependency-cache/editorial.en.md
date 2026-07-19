# Editorial

## Intuitive Approach

For each round, scan every dependency of every TU and test membership in the changed set, taking `O(QM)` time. Reverse adjacency lists are better, but repeatedly changing the same high-degree header still performs `O(N)` scalar marking operations per round.

## Optimal Approach: Header-to-TU Bitsets

Build one length-`N` bitset per header. Bit `s` is set exactly when TU `s` depends on that header. For one round, OR together the bitsets of all changed headers, then popcount the result. Begin every round with a fresh all-zero accumulator, matching the clean baseline after rebuilding.

In Python, build each row with a mutable `bytearray` and convert it once to an arbitrary-precision integer. Repeatedly performing `mask |= 1 << s` on an immutable large integer may copy the entire bitset for every edge, degrading construction to `O(M ceil(N/w))`. Other languages can use arrays of 32- or 64-bit words. These are implementations of the same word-parallel algorithm.

## Correctness Proof

Bit `s` of header `h`'s bitset is one if and only if dependency `(s,h)` appears in the input. A bit is one in the OR if and only if it is one in at least one changed header's bitset, which holds exactly when TU `s` read at least one header changed this round. That is precisely the cache-miss definition. Popcount returns the size of this set. Independent accumulators prevent changes from an earlier round from leaking into the next, so every output is correct.

## Complexity

Let `w` be the machine-word width, `R=ceil(N/w)`, and `K` the total number of changed headers over all queries. Allocating and clearing the `H` bitset rows costs `O(HR)`, setting edges costs `O(M)`, and query ORs, accumulator clears, and popcounts total `O((K+Q)R)`. Total time is `O(HR+M+(K+Q)R)`, with `O(HR)` auxiliary bitset space. The Rust, Python, JavaScript, and TypeScript references retain complete input and buffered output, adding `O(M+Q+K)` resident I/O space; when `N=H=1`, this term is not absorbed by `O(HR)`.

## Common Mistakes

- Adding popcounts of individual bitsets without ORing first, double-counting TUs.
- Reusing the previous round's accumulator.
- Forgetting `>>> 0` when counting signed 32-bit JavaScript words.
- Allocating `N*H` bytes rather than bits, using eight times the necessary space.
- Building immutable big integers one edge at a time and overlooking full-row copies.
