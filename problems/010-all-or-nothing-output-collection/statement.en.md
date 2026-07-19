# All-or-Nothing Output Collection

A WASM OJ collects output files after the submitted program exits, but a file's metadata and its actual contents may no longer agree during collection. If quota validation used metadata first and the subsequent read returned a different length, a TOCTOU problem would result. Output files must also share the same byte budget already used by stdout and stderr.

To keep results independent of file-enumeration order, the `N` output files must be processed in UTF-8 byte lexicographic order of their paths. Every path is ASCII, so this is ordinary bytewise lexicographic order; when one string is a prefix of another, the shorter string comes first. Stdout and stderr have already consumed `U` bytes together.

Each file record contains `path metadataLength actualLength`. Before processing a file, compare the two lengths. A difference is a TOCTOU mismatch between metadata and the actual read. Only when they match may `metadataLength` be added to the shared byte budget.

Every budget query independently starts with no files collected but `U` bytes already used, and processes files in canonical order:

1. If `U>budget` initially, fail immediately for quota without touching any path.
2. For the current file, check mismatch first and fail immediately if one exists.
3. Otherwise, if adding the file would exceed the budget, fail for quota at that path.
4. Otherwise, include the complete file and continue.

Collection has all-or-nothing semantics: a failure returns no partial file collection. Input budgets are guaranteed to be nondecreasing.

## Input

The first line contains `N Q U`. The next `N` lines contain file records in arbitrary order. The final `Q` lines each contain a nondecreasing `budget`.

## Output

On success, output `OK N finalUsedBytes`. On failure, output `ERR MISMATCH path` or `ERR QUOTA path`. For the special initial failure `U>budget`, replace the path with `-`: `ERR QUOTA -`.

For the same file, `MISMATCH` has priority over `QUOTA`. All paths are distinct.

## Constraints

- `1 ≤ N,Q ≤ 200000`
- `0 ≤ U,budget ≤ 9×10^18`
- `0 ≤ metadataLength,actualLength ≤ 10^12`
- `U + Σ metadataLength ≤ 9×10^18`
- Each path has length `2..200000`, starts with `/`, contains only lowercase ASCII letters, digits, `-`, and `/`, has no empty segment, and does not end with `/`.
- Total path length is at most `2000000`.
- `Q × (maximum path byte length) ≤ 2000000`, so repeated error messages also have bounded total path output.
- The budget sequence is nondecreasing.

The full constraints rule out sorting or scanning all files again for every query.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 6 3
/z 4 4
/a 2 2
/m 5 7
/b 3 3
2
3
4
5
8
100
```

Output:

```text
ERR QUOTA -
ERR QUOTA /a
ERR QUOTA /a
ERR QUOTA /b
ERR MISMATCH /m
ERR MISMATCH /m
```

### Example Two

Input:

```text
2 3 0
/b 5 5
/a 0 0
0
5
10
```

Output:

```text
ERR QUOTA /b
OK 2 5
OK 2 5
```

### Example Three

Input:

```text
2 3 1
/z 1 1
/a 100 99
0
1
200
```

Output:

```text
ERR QUOTA -
ERR MISMATCH /a
ERR MISMATCH /a
```

<!-- END GENERATED SAMPLES -->
