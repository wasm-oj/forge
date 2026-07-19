# Sparse Files Are Not Free

A VFS contains `F` existing empty files. Each has a logical size and a cursor, both initially `0`. The sum of all logical file sizes may not exceed byte quota `B`. Sparse holes count toward logical size and quota even though their contents are not physically written.

Execute `N` operations in order:

- `SEEK x position`: set file `x`'s cursor to an absolute position. It may be beyond EOF and does not change the size.
- `WRITE x length`: if `length>0`, the candidate new size is `max(oldSize,cursor+length)`; if `length=0`, both size and cursor remain unchanged. After a successful nonzero write, advance the cursor by `length`.
- `TRUNCATE x size`: the candidate new size is exactly `size`. The cursor is unchanged, even if it lies beyond the new EOF.

`SEEK` always succeeds. If the candidate sum of all logical file sizes for a `WRITE` or `TRUNCATE` would exceed `B`, output a quota error and leave size, cursor, and peak usage entirely unchanged. Otherwise commit all changes atomically.

## Input

The first line contains `F N B`, followed by `N` operation lines. File IDs are 1-based.

## Output

For each operation, output one line. On success:

```text
OK fileSize cursor usedBytes
```

On quota failure:

```text
ERR QUOTA fileSize cursor usedBytes
```

Every field describes the state after that operation. Finally output `SUMMARY usedBytes peakBytes`. The peak considers global `usedBytes` only after successful commits and includes the initial zero state.

## Constraints

- `1 ≤ F,N ≤ 200000`
- `0 ≤ B ≤ 9×10^18`
- `1 ≤ x ≤ F`
- `0 ≤ position,length,size ≤ 9×10^18`
- Every `cursor+length` encountered during execution is guaranteed not to exceed `9×10^18`.

Let `E` be the largest offset ever touched. It can reach `9×10^18`, so a solution may not materialize holes. The full constraints also rule out recomputing the sum of all file sizes after every operation.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
2 6 10
SEEK 1 7
WRITE 1 3
SEEK 2 5
WRITE 2 1
TRUNCATE 1 4
WRITE 2 1
```

Output:

```text
OK 0 7 0
OK 10 10 10
OK 0 5 10
ERR QUOTA 0 5 10
OK 4 10 4
OK 6 6 10
SUMMARY 10 10
```

### Example Two

Input:

```text
1 5 0
SEEK 1 100
WRITE 1 0
TRUNCATE 1 0
WRITE 1 1
SEEK 1 0
```

Output:

```text
OK 0 100 0
OK 0 100 0
OK 0 100 0
ERR QUOTA 0 100 0
OK 0 0 0
SUMMARY 0 0
```

### Example Three

Input:

```text
1 7 20
TRUNCATE 1 12
SEEK 1 3
WRITE 1 4
SEEK 1 18
WRITE 1 2
TRUNCATE 1 5
WRITE 1 1
```

Output:

```text
OK 12 0 12
OK 12 3 12
OK 12 7 12
OK 12 18 12
OK 20 20 20
OK 5 20 5
ERR QUOTA 5 20 5
SUMMARY 5 20
```

<!-- END GENERATED SAMPLES -->
