# Mounted Directory-Tree Baseline

Before each isolated WASM OJ execution starts, the system mounts test inputs and creates the output files that the problem permits. These initialization resources already occupy VFS quota before the submitted program begins, so they must not be mistaken for usage added during execution. We need to establish a reproducible mount baseline first.

The environment mounts `M` read-only input files and pre-creates `O` zero-length output files. To keep the task focused on directory-tree resource accounting, a canonical absolute path is represented by positive integer segments: `k s1 ... sk` denotes `/s1/.../sk`. The last segment is the filename, and all preceding segments are parent directories.

During mounting, every required parent directory is created automatically, but the same directory is counted only once no matter how many files share it. The guest root `/` always exists and consumes one inode, and every file consumes one inode of its own. Baseline bytes include only the logical sizes of read-only input files; pre-created output files have size zero.

The system will seal this baseline under byte quota `B` and inode quota `I`. Compute its byte and inode usage and determine whether it can be sealed under both quotas.

## Input

The first line contains `M O B I`.

The next `M` lines each contain `k s1 ... sk size`; the following `O` lines each contain `k s1 ... sk`.

All file paths are distinct, and no file path is a strict prefix of another file path, so no file/directory kind conflict can occur.

## Output

If both baseline values are within quota, output:

```text
ACCEPT baselineBytes baselineInodes remainingBytes remainingInodes
```

Otherwise output:

```text
REJECT baselineBytes baselineInodes missingBytes missingInodes
```

Each missing value is `max(0,baseline-quota)`. Even when only one resource is insufficient, output `0` for the other.

## Constraints

- `0 ≤ M,O ≤ 200000`, `1 ≤ M+O ≤ 200000`
- Every path has `1 ≤ k`; the total number `S` of segment occurrences over all paths is at most `200000`.
- `1 ≤ si ≤ 10^9`
- `0 ≤ size ≤ 9×10^18`, and the sum of all input-file sizes is at most `9×10^18`.
- `0 ≤ B,I ≤ 9×10^18`

The full constraints rule out comparing every new directory prefix linearly against a list of existing prefixes.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
2 2 100 10
3 1 2 3 40
2 1 4 20
3 1 2 5
1 6
```

Output:

```text
ACCEPT 60 7 40 3
```

### Example Two

Input:

```text
1 1 4 2
2 9 1 5
2 9 2
```

Output:

```text
REJECT 5 4 1 2
```

### Example Three

Input:

```text
3 2 30 8
4 1 2 3 10 7
4 1 2 3 11 8
3 1 2 12 9
3 1 5 13
1 14
```

Output:

```text
REJECT 24 10 0 2
```

<!-- END GENERATED SAMPLES -->
