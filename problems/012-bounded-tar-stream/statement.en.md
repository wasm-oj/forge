# 512-Byte Archive

A WASM OJ needs to accept dependency archives for problems or programs, but it cannot safely expand unknown contents first and decide whether they were valid afterward. To reject damaged or unsupported structures before allocating extraction space, a low-level parser has already converted the archive into header events. The remaining safety check must be performed **without expanding any payload**.

Every event occupies one 512-byte header, followed by `size` payload bytes and zero padding to a multiple of 512. Therefore the offset of the next event is:

`offset + 512 + ceil(size / 512) * 512`.

Event types and their meanings are:

- `F`: a regular file; counts toward both the file count and extracted bytes.
- `D`: a directory; `size` must be 0.
- `G`, `P`: GNU long-path or PAX path metadata. `name` overrides the path of the next `F/D`, and `size` must equal the ASCII byte length of `name` plus one. Metadata may not appear while previous metadata is still waiting to be consumed.
- Any other uppercase letter is unsupported.

Each event also provides a stored checksum and a calculated checksum, which must match. A valid path must be nonempty, relative, and canonical: it neither begins nor ends with `/`; every segment contains only lowercase letters, digits, `.`, `_`, and `-`, and no segment is `.` or `..`.

When metadata is pending, the next `F/D` uses the metadata `name` as its effective path and ignores its own header `name`. Validate the event stream under these rules without reading or expanding any payload.

## Input

The first line contains `N maxFiles maxBytes`. Each of the next `N` lines has:

```text
offset type name size storedChecksum calculatedChecksum
```

All event fields are supplied even if an earlier event would already cause rejection.

## Output

Process events in order and stop at the first error, outputting `REJECT i CODE`. If one event has several errors, report only the first according to this priority:

1. `OFFSET`: `offset` differs from the expected value; the first expected offset is 0.
2. `CHECKSUM`: the two checksums differ.
3. `TYPE`: the type is not `F/D/G/P`.
4. `STATE`: `G/P` appears while metadata is already pending.
5. `META_SIZE`: metadata size is not the path length plus one.
6. `PATH`: the metadata path, or the effective path of an `F/D`, is invalid.
7. `ENTRY_SIZE`: a `D` has nonzero size.
8. `LIMIT`: adding an `F` would exceed `maxFiles` or make cumulative extracted bytes exceed `maxBytes`.

If metadata remains unused after all events, output `REJECT N+1 STATE`. Otherwise output:

```text
ACCEPT fileCount extractedBytes endOffset
```

All indices are 1-based. An entry that fails a limit check is not included in the output statistics.

## Constraints

- `1 ≤ N ≤ 200000`
- `0 ≤ maxFiles ≤ N`
- `0 ≤ maxBytes ≤ 9×10^18`
- Every numeric value is a nonnegative integer at most `9×10^18`.
- `type` is one uppercase letter.
- `name` is a visible ASCII token of length `1..200`.
- The layout endpoint computed from all `size` values is guaranteed not to exceed `9×10^18`.
- A `size` may be far larger than allocatable memory; a full solution must not create payload storage or an array proportional to archive size.

All names are visible ASCII, so path byte length equals character count.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 3 1000
0 F a.txt 5 10 10
1024 D dir 0 11 11
1536 F dir/b 600 12 12
```

Output:

```text
ACCEPT 2 605 3072
```

### Example Two

Input:

```text
2 1 10
0 G very/long/path 15 7 7
1024 F short 3 8 8
```

Output:

```text
ACCEPT 1 3 2048
```

### Example Three

Input:

```text
2 1 10
0 G a 2 1 1
1024 P b 2 2 2
```

Output:

```text
REJECT 2 STATE
```

<!-- END GENERATED SAMPLES -->
