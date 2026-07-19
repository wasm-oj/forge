# Editorial

## Intuitive Approach

Maintain a conventional PRNG and generate every byte from position 0 through each chunk endpoint. Total consumption `P` may reach `9×10^18`, so `O(P)` time is impossible.

## Optimal Approach: Counter-Based Random Access

The formula makes word `floor(x/8)` a pure function of the seed and counter, so any byte can be accessed in `O(1)`. Maintain the consumed position `pos`. A chunk of length `k` has endpoints `pos` and `pos+k-1`; call the byte function for both, then update `pos+=k`.

Every intermediate multiplication must retain only the low 64 bits. C, C++, Rust, and Go use unsigned 64-bit wrapping; Python masks with `2^64-1` after every step; JavaScript and TypeScript use `bigint` and a mask.

## Correctness Proof

The byte function implements every equation defining one stream offset. The global conversion then uniquely selects startup or user stream according to `p<S`. Call `i` begins at the sum of all previous lengths and ends at that position plus `k_i-1`; these are exactly the two positions queried by the algorithm. After the update, `pos` equals the new cumulative length. Induction over calls proves that every output pair is correct.

## Complexity

Every call performs exactly two constant-size mixes, so time is `O(Q)` and core auxiliary space is `O(1)`. C, C++, and Go references stream input and output. The current Rust, Python, JavaScript, and TypeScript references buffer all input and output, so actual peak allocated space is `O(Q)`. Output itself has size `Θ(Q)`; when the environment permits full streaming, space excluding I/O buffers remains `O(1)`.

## Common Mistakes

- Failing to restart the user stream at offset 0 at global position `S`.
- Using signed shifts or forgetting 64-bit multiplication wraparound.
- Reading bytes within a word in big-endian order.
- Using `pos+k` instead of `pos+k-1` for the chunk endpoint.
