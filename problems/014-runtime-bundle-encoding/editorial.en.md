# Editorial

## Intuitive Approach

Insert records one at a time into an already-sorted path array, then concatenate every field. Sorting takes `O(N^2)` in the worst case, and repeatedly appending to an immutable string can introduce another quadratic copying cost.

## Optimal Approach: Comparison Sort and Streaming Encoding

First comparison-sort records by path. Use fixed-width big-endian helpers for u32 and u64 fields. Emit two hex digits for every byte of a path or `T` payload. A `B` payload is already canonical hexadecimal and may be emitted directly. Type, path length, and payload length all precede their contents, so a decoder can determine every field boundary uniquely.

An implementation may collect hexadecimal fragments in an array and join once, or stream them directly. Do not dump an integer's in-memory representation, because host byte order is not guaranteed to be big-endian.

## Correctness Proof

After sorting, record order is uniquely determined by the unique paths. Every integer helper emits exactly the specified fixed-width big-endian bytes, and the conversions of ASCII and binary tokens preserve their contents byte for byte. Thus every segment of the algorithm's output equals the corresponding segment of the format definition. Conversely, a decoder reads the fixed magic and count, then uses the tag and two lengths to consume the path and payload and advance to the next record uniquely. Therefore any change in type, length, path, or payload changes at least one encoded byte, so the bundle is unambiguous and the output is correct.

## Complexity

Let `B` be the total number of input path and payload bytes. Time is `O(N log N+B)`. Storing records and the output uses `O(N+B_out)` space; with streaming output, space beyond the sorting data can be reduced to `O(N)`.

## Common Mistakes

- Forgetting that a binary token's byte length is half its hexadecimal character length.
- Using little-endian encoding or omitting leading zero bytes.
- Encoding records in input order.
- Treating the empty-payload sentinel `-` as a content byte.
