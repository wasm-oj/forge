# Chunk-Independent Deterministic Randomness

If `random_get` uses the host's random source directly, the same WASM OJ submission may be impossible to replay deterministically. Its result also cannot depend on how the runtime divides reads into chunks: regardless of the requested length, every global position must have one value that can be computed directly.

The system divides the conceptual random sequence into two parts. Its first `S` bytes come from the startup stream. After that, the user stream begins at its own offset 0. The `Q` calls to `random_get` consume `k_i` bytes in order, with each call beginning where the previous one ended.

To verify the endpoints after chunking, output the first and last byte returned by every call. A chunk may be enormous, so the bytes between those endpoints do not need to be generated.

For a stream with seed `s`, the byte at offset `x` is defined as follows, with all arithmetic reduced modulo `2^64` after each operation:

```text
z = s + 0x9e3779b97f4a7c15 * (floor(x/8) + 1)
z = (z xor (z >> 30)) * 0xbf58476d1ce4e5b9
z = (z xor (z >> 27)) * 0x94d049bb133111eb
w = z xor (z >> 31)
byte(x) = (w >> (8 * (x mod 8))) & 255
```

Shifts are unsigned logical shifts, and bytes within a word use little-endian order. For global position `p`, use the startup seed and offset `p` when `p<S`; otherwise use the user seed and offset `p-S`.

## Input

The first line contains `startupSeed userSeed S Q`. The second line contains `Q` positive integers `k_i`.

## Output

For every call, output `first last`, with both values in decimal from 0 through 255. If a chunk crosses `S`, compute each endpoint using the stream containing that endpoint.

## Constraints

- Each seed lies in `[0,2^64-1]`.
- `0 ≤ S ≤ 9×10^18`
- `1 ≤ Q ≤ 200000`
- `1 ≤ k_i`
- The sum of all `k_i` is at most `9×10^18`.
- The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
0 1 10 4
1 7 5 9
```

Output:

```text
175 175
205 226
244 2
137 101
```

### Example Two

Input:

```text
18446744073709551615 0 0 3
8 1 16
```

Output:

```text
175 226
244 244
101 236
```

### Example Three

Input:

```text
42 99 17 3
16 2 15
```

Output:

```text
149 40
82 227
107 8
```

<!-- END GENERATED SAMPLES -->
