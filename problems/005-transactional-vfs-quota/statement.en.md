# Transactional VFS Quotas

A virtual file system has `P` possible canonical guest paths; ID `x` represents `/file/x`. Initially, none of them exists. The total logical size of all files may not exceed `B` bytes, and the number of existing files (inodes) may not exceed `I`.

Execute `N` operations in order:

- `CREATE x`: create a zero-length file.
- `WRITE x offset length`: write `length` bytes to the file. If `length>0`, its new logical size is `max(oldSize,offset+length)`; if `length=0`, its size is unchanged.
- `TRUNCATE x size`: set the logical size to exactly `size`, either growing or shrinking it.
- `UNLINK x`: delete the file and release all of its bytes and one inode.

Every operation is a transaction. If it fails, existence, size, usage, and peak usage must all remain unchanged. Determine errors in this order:

- `CREATE`: return `EXISTS` first if the file exists; otherwise return `INODES` if the inode limit would be exceeded.
- `WRITE`/`TRUNCATE`: return `NOENT` first if the file does not exist; otherwise return `BYTES` if the byte limit would be exceeded.
- `UNLINK`: return `NOENT` if the file does not exist.

Output `OK` on success and `ERR code` on failure. Any `BYTES` or `INODES` error sets the sticky quota-failure bit to `1`; it is never cleared. `EXISTS` and `NOENT` do not affect it.

After all operations, output current usage, peak usage over all successfully committed states, and the sticky bit.

## Input

The first line contains `P N B I`, followed by the `N` operations above. IDs are 1-based.

## Output

Output one result line per operation, followed by:

```text
SUMMARY usedBytes usedInodes peakBytes peakInodes sticky
```

Byte and inode peaks are the separate maxima ever observed; they need not occur at the same time. The initial all-zero state is included.

## Constraints

- `1 ≤ P,N ≤ 200000`
- `0 ≤ B ≤ 9×10^18`
- `0 ≤ I ≤ P`
- `1 ≤ x ≤ P`
- `0 ≤ offset,length,size ≤ 9×10^18`
- Every `WRITE` satisfies `offset+length ≤ 9×10^18`.

A logical hole consumes quota. For example, `WRITE x 10 5` on an empty file gives it size `15`. The full constraints rule out rescanning all paths to recompute usage after every operation.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 8 10 2
CREATE 1
WRITE 1 0 6
CREATE 2
WRITE 2 0 5
CREATE 3
TRUNCATE 1 4
UNLINK 2
CREATE 3
```

Output:

```text
OK
OK
OK
ERR BYTES
ERR INODES
OK
OK
OK
SUMMARY 4 2 6 2 1
```

### Example Two

Input:

```text
2 7 0 1
WRITE 1 0 1
CREATE 1
CREATE 1
TRUNCATE 1 1
UNLINK 2
UNLINK 1
CREATE 2
```

Output:

```text
ERR NOENT
OK
ERR EXISTS
ERR BYTES
ERR NOENT
OK
OK
SUMMARY 0 1 0 1 1
```

### Example Three

Input:

```text
2 8 20 2
CREATE 1
WRITE 1 10 5
TRUNCATE 1 4
WRITE 1 18 2
CREATE 2
TRUNCATE 2 1
UNLINK 1
TRUNCATE 2 20
```

Output:

```text
OK
OK
OK
OK
OK
ERR BYTES
OK
OK
SUMMARY 20 1 20 2 1
```

<!-- END GENERATED SAMPLES -->
