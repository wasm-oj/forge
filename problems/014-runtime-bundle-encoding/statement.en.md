# Unambiguous Runtime Bundle

Encode text and binary files into a unique, prefix-free runtime bundle. First sort all files by ASCII lexicographic path order, then output these bytes:

1. the ASCII magic `WOBJ`;
2. the file count as an unsigned 32-bit big-endian integer;
3. each file in order: a one-byte type tag (`T=01`, `B=02`), the path byte length as u32 big-endian, the ASCII path bytes, the payload byte length as u64 big-endian, and the payload bytes.

The length prefixes and type tag make field boundaries unambiguous.

## Input

The first line contains `N`. Each of the next `N` lines contains `type path payloadToken`.

- For `T`, a nonempty `payloadToken` is used directly as visible ASCII bytes.
- For `B`, a nonempty `payloadToken` is lowercase hexadecimal, with every two characters representing one byte.
- For either type, the single token `-` represents an empty payload. Consequently, this problem cannot represent a text file whose entire content is one `-` byte.

## Output

Output one line containing the complete bundle bytes as contiguous lowercase hexadecimal, with no whitespace or `0x` prefix.

## Constraints

- `1 ≤ N ≤ 50000`
- Every path is unique and is a canonical relative ASCII path of length `1..100`.
- Path segments contain only lowercase letters, digits, `.`, `_`, and `-`, and are never empty, `.`, or `..`.
- A `T` payload token other than `-` contains ASCII bytes 33 through 126 and has length at most `200000`.
- A `B` payload token other than `-` is a positive even-length string over `[0-9a-f]`.
- The sum `B` of all path bytes and decoded payload bytes is at most `200000`.
- Every length field is guaranteed to fit its specified unsigned integer type.

The full tests rule out `O(N^2)` sorting.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
2
T b x
B a ff00
```

Output:

```text
574f424a000000020200000001610000000000000002ff00010000000162000000000000000178
```

### Example Two

Input:

```text
1
T empty -
```

Output:

```text
574f424a000000010100000005656d7074790000000000000000
```

### Example Three

Input:

```text
2
T x hi
B y 6869
```

Output:

```text
574f424a000000020100000001780000000000000002686902000000017900000000000000026869
```

<!-- END GENERATED SAMPLES -->
