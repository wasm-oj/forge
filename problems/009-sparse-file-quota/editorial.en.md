# Editorial

## Intuitive Approach

Representing each file as a byte array forces a write after a huge seek to allocate the entire hole, requiring `O(E)` time and space even though `E` may be `9×10^18`. Storing only sizes still takes `O(FN)` if every quota check rescans all `F` files.

## Optimal Approach: Incremental Size Accounting

Store only `size[x]` and `cursor[x]` for each file, and globally maintain `used=sum(size)`. After computing candidate `newSize`, let `delta=newSize-oldSize`. If it is positive and `delta>B-used`, reject; otherwise update `used` and `size` by the difference. Shrinking releases the difference directly. Testing `delta>B-used` instead of `used+delta>B` avoids unsigned overflow.

Advance the write cursor only after a successful nonzero write. A zero-length write and every failed transaction leave it unchanged. `TRUNCATE` never changes the cursor. Update the peak after every success.

## Correctness Proof

Assume inductively that before an operation, `used` equals the sum of all sizes. `SEEK` changes only one cursor, so the sum is preserved. A `WRITE` candidate is the maximum of the old EOF and the write endpoint; a `TRUNCATE` candidate is the specified size. In either case, only one file's size can change, so `new-old` is the exact change in the global total. The quota test is therefore necessary and sufficient. On success the algorithm commits the correct size, total, and prescribed cursor simultaneously; on failure it commits none of them, preserving the invariant. The peak is updated only from correct committed states. Thus every state line and the final summary are correct.

## Complexity

Initialization takes `O(F)` and every operation takes `O(1)`, for total time `O(F+N)`. The core state uses `O(F)` auxiliary space and is independent of the largest offset. Including buffered input/output, the common worst-case space bound of the seven references is `O(F+N)`.

## Common Mistakes

- Adding only `length` for a sparse write and ignoring the hole before the cursor.
- Clamping the cursor to EOF when truncating downward; it must remain unchanged.
- Advancing a `WRITE` cursor after a quota failure.
- Extending to the cursor or advancing it on a zero-length `WRITE`.
