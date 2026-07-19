# Source Tree Evidence

Given a collection of source-tree records, construct the unique canonical provenance manifest. The evidence subtree itself must be excluded so that the evidence does not recursively contain itself.

The first line names the evidence root path `E`. Records have three forms:

- `F path executable length digest` for a file;
- `L path target` for a symbolic link;
- `D path` for a tombstone representing a deleted item.

Each digest is a precomputed eight-character lowercase hexadecimal token. All paths are normalized and pairwise distinct. Exclude a record if its path is exactly `E` or begins with `E/`. For example, when `E` is `proof`, `proof/a` is excluded but `proof2/a` is not.

Sort all remaining records by strictly increasing UTF-8 bytes of `path`. The allowed input characters are ASCII, so this is ordinary ASCII lexicographic order. Every field other than record order must be reproduced exactly.

## Input

The first line contains `N E`. The next `N` lines contain records in one of the three formats above.

## Output

First output the number `M` of retained records. Then output the `M` retained records, unchanged, in canonical order.

## Constraints

- `1 <= N <= 200000`
- A path has length `1..120` and uses lowercase letters, digits, `_`, `-`, `.`, and `/`.
- A path neither starts nor ends with `/`, has no empty segment, and has no `.` or `..` segment.
- `E` follows the same path rules.
- A symbolic-link target is a nonempty token of length `1..120` using the same character set.
- `executable` is `0` or `1`.
- `0 <= length <= 10^18`

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 .evidence
F src/main.c 1 12 deadbeef
D old.c
F .evidence/report 0 3 00000001
L link src/main.c
F .evidence2/x 0 4 00000002
```

Output:

```text
4
F .evidence2/x 0 4 00000002
L link src/main.c
D old.c
F src/main.c 1 12 deadbeef
```

### Example Two

Input:

```text
3 proof
F proof 0 1 00000000
F proof/a 0 2 00000001
D proof/old
```

Output:

```text
0
```

### Example Three

Input:

```text
4 out
F out2/a 1 9 abcdef01
L z a
D a
F out/x 0 2 12345678
```

Output:

```text
3
D a
F out2/a 1 9 abcdef01
L z a
```

<!-- END GENERATED SAMPLES -->
