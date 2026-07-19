# Mount-Tree Conflict Detection

When a WASM OJ constructs an isolated file system, it mounts inputs, tools, and working directories into one virtual file tree. Mount settings may come from different parts of the configuration. If two records occupy the same path, or if a regular file is placed at an ancestor of another item, the resulting tree has no valid interpretation.

The system receives a sequence of directory (`D`) and regular-file (`F`) records. Either condition below makes a pair conflict:

1. The two records have exactly the same path, regardless of their kinds.
2. One record is a regular file whose path is a **strict ancestor** of the other record's path.

Ancestry is determined by complete path segments. For example, `/a` is an ancestor of `/a/b`, but not of `/ab`. The root path `/` is an ancestor of every other path.

Configuration validation must report the earliest conflict that can be established in input order. For conflicting record indices `i < j`, minimize `j` first, then minimize `i` among ties. If no conflict exists, output `VALID`.

## Input

The first line contains integer `N`. Each of the next `N` lines contains `kind path`.

- `kind` is `F` or `D`.
- A path is canonical and absolute. The root is `/`. Every other path starts with `/`, does not end with `/`, and consists of segments containing only lowercase English letters, digits, `.`, `_`, and `-`; a segment is never `.` or `..`.
- Records are numbered from 1.

## Output

If there is no conflict, output:

```text
VALID
```

Otherwise output:

```text
CONFLICT i j
```

where `(i,j)` obeys the tie-break above.

## Constraints

- `1 ≤ N ≤ 200000`
- Each path has length at most `200`.
- The sum `S` of all path lengths is at most `2000000`.
- Input is UTF-8, but the path restrictions make all compared contents ASCII.

Checking every pair exceeds every resource policy. An `O(S log N)` tree-order sorting solution can earn the looser-policy points; the strictest instruction-cost policy requires a deterministic `O(S)` solution.

An expected `O(S)` hash table is not a deterministic worst-case `O(S)` solution. Because the legal path-character alphabet has fixed size, a first-child/next-sibling character trie can examine only a constant number of siblings at each node.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4
D /src
F /src/main.c
D /include
F /include/a.h
```

Output:

```text
VALID
```

### Example Two

Input:

```text
3
D /a
F /a/b
D /a/b/c
```

Output:

```text
CONFLICT 2 3
```

### Example Three

Input:

```text
4
D /x
F /x/a
D /x/b
F /x
```

Output:

```text
CONFLICT 1 4
```

<!-- END GENERATED SAMPLES -->
