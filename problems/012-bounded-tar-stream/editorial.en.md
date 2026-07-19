# Editorial

## Intuitive Approach

Allocate payloads, padding, and the whole archive according to each size, then simulate byte offsets. For archive length `A`, both time and space become `O(A)`. Since `A` may reach `9×10^18`, this is impossible.

## Optimal Approach: Streaming State Machine

Maintain only `expectedOffset`, an optional pending metadata path, the file count, and extracted bytes. Check each event in exactly the error order specified. No content is needed for layout: compute

```text
blocks = (size + 511) // 512
```

and increase the expected offset by `512 + 512*blocks`. A `G/P` stores only one path of at most 200 bytes; clear it immediately after the next `F/D` consumes it.

Validate a path by splitting on `/`, checking every segment's allowed characters, and rejecting empty segments, `.`, and `..`.

## Correctness Proof

Induct on the number of processed events. Initially the expected offset is 0, metadata is absent, and both statistics are zero, matching an empty archive. Assume the state is correct after event `i-1`. Event `i` is checked in the exact priority order from the specification, so rejection reports both the earliest event and its highest-priority error. If it passes, the offset formula skips exactly the header, payload, and padding; metadata state changes uniquely according to the event type; and only `F` updates the two quota statistics. Thus the invariant remains true after event `i`. By induction, after all events the statistics and end offset are correct, and the final pending-metadata check catches exactly an unconsumed metadata record.

## Complexity

Let `S` be the total length of all names and `T` the complete textual input size. Time is `O(N+S)`. C, C++, Rust, Go, and Python read line by line, so solver auxiliary space is `O(S_max)`, where `S_max≤200`. Forge's JavaScript/TypeScript API supplies only an immutable full input string through `readAsString()`, so those languages necessarily retain `O(T)` host-provided input; their parser uses a cursor and no all-token array, leaving its additional state at `O(S_max)`. The 256 MiB memory limit includes this runtime/input-contract cost.

## Common Mistakes

- Using floor division instead of `ceil(size/512)`.
- Counting metadata as a regular file, or failing to clear it after the next `F/D`.
- Checking type before offset or checksum, producing the wrong error code.
- Using 32-bit integers, or JavaScript `number`.
