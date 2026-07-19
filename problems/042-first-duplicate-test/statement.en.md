# First Duplicate Test

While designing the problem-import pipeline for a WASM OJ, we needed to prevent the same test case from being added more than once. Every test already has a fingerprint before entering storage, so full file contents do not need to be compared again. For reproducible diagnostics, however, we want not only to detect a duplicate but also to identify the earliest duplicate and its original source.

The system receives `N` test-case fingerprints in arrival order. Each fingerprint is a non-empty lowercase hexadecimal token. Fingerprints are compared as exact token strings, not as hexadecimal numbers: for example, `0` and `00` are different fingerprints.

Find the earliest arrival that duplicates an earlier fingerprint. More precisely, find the smallest index `i` for which an index `j < i` has the same fingerprint, and report `i` together with the earliest such index `j` for that fingerprint. All indices are one-based.

If every fingerprint is distinct, report `NONE`.

## Input

The first line contains an integer `N`.

The remaining input contains `N` whitespace-separated fingerprints in arrival order.

## Output

If a duplicate exists, output `i j`, where `i` is the smallest duplicate index and `j` is the first index containing the same token.

Otherwise, output `NONE`.

## Constraints

- `1 <= N <= 200000`
- Every fingerprint has length from `1` to `32`.
- Every character is one of `0`–`9` or `a`–`f`.
- Comparisons are exact token comparisons; fingerprints are not numbers.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5
aa bb cc bb aa
```

Output:

```text
4 2
```

### Example Two

Input:

```text
4
0 a 00 f0
```

Output:

```text
NONE
```

### Example Three

Input:

```text
6
0 a 00 a ff 0
```

Output:

```text
4 2
```

<!-- END GENERATED SAMPLES -->
