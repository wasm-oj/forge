# Canonical Replay Bundle

A textual replay bundle contains `B` blob records followed by `R` manifest references. A blob record has the form `digest declared actual`; a reference contains only a digest. Each digest is a precomputed, collision-free, eight-character lowercase hexadecimal token. You do not need to implement hashing.

A bundle is canonical only if all of the following conditions hold:

1. blob digests are strictly increasing;
2. every blob's declared length equals its actual length;
3. reference digests are strictly increasing;
4. every reference digest occurs among the blobs.

If the bundle is invalid, report only the first error phase in the order above. Within a phase, report the smallest 1-indexed record position. The possible forms are `INVALID BLOB_ORDER i`, `INVALID LENGTH i`, `INVALID REF_ORDER i`, and `INVALID MISSING i`. For an ordering error, `i` is the first record whose digest is not greater than the previous digest, so `i >= 2`.

If the bundle is valid, output `VALID total`, where `total` is the sum of the actual lengths of all referenced blobs. Unreferenced blobs do not contribute.

## Input

The first line contains `B R`. The next `B` lines contain blob records, followed by `R` lines containing reference digests.

## Output

Output exactly one line in the format specified above.

## Constraints

- `0 <= B, R <= 200000`
- `B + R >= 1`
- Every length is in `[0, 10^18]`.
- For every valid bundle, `total <= 9 * 10^18`.

The limits apply to every official test case. Error phases and record positions must follow the stated priority exactly.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 2
00000001 5 5
00000002 7 7
0000000a 9 9
00000001
0000000a
```

Output:

```text
VALID 14
```

### Example Two

Input:

```text
2 1
00000002 1 2
00000001 5 5
ffffffff
```

Output:

```text
INVALID BLOB_ORDER 2
```

### Example Three

Input:

```text
2 2
00000001 3 3
00000002 4 4
00000001
00000003
```

Output:

```text
INVALID MISSING 2
```

<!-- END GENERATED SAMPLES -->
