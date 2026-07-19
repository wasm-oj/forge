# Build Fingerprint

In a WASM OJ, identical source code and compilation settings should hit the same build cache, while any input that can change the artifact must produce a different identity. If a fingerprint depended on file-enumeration order, the same project could be compiled repeatedly merely because its inputs arrived in another order. We therefore need a unique canonical preimage.

A real build digest hashes this canonical preimage. This problem does not ask you to implement SHA-256 or make the hash function itself an obstacle. Instead, output a token representation of the canonical preimage.

A project has `N` files, each with a unique path and a precomputed digest. Every build specifies a compiler, target, optimization level, dependency digest, and an arbitrarily ordered set of file indices.

The canonical representation preserves the input order of those four metadata fields and orders the file portion by ASCII lexicographic path order. Produce the unique token sequence that would be supplied to the later hashing step.

## Input

The first line contains `N Q`. The next `N` lines contain `path digest`. Each of the following `Q` lines has:

```text
compiler target optimization dependencyDigest K fileId_1 ... fileId_K
```

## Output

For each build, output one line:

```text
compiler target optimization dependencyDigest K path_1 digest_1 ... path_K digest_K
```

The file paths must be strictly increasing. When `K=0`, the line ends immediately after `0`; do not add a sentinel for the empty set.

## Constraints

- `1 ≤ N,Q ≤ 200000`; the sum of `K` over all builds is at most `400000`.
- A path is a canonical relative path of length `1..100`, contains only lowercase letters, digits, `.`, `_`, `-`, and `/`, and has no empty, `.`, or `..` segment. All paths are unique.
- A digest is a lowercase hexadecimal token of length `8..64`. Metadata tokens contain only lowercase letters, digits, `.`, `_`, and `-`.
- File IDs within one build are distinct and lie in `1..N`.
- The total input text length is at most 4 MB. Comparison uses ASCII bytes and is locale-independent.

Quadratic insertion into a sorted array does not pass the full tests.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 1
src/z.c aaaaaaaa
src/a.c bbbbbbbb
inc/x.h cccccccc
clang wasm32 o2 deadbeef 3 1 3 2
```

Output:

```text
clang wasm32 o2 deadbeef 3 inc/x.h cccccccc src/a.c bbbbbbbb src/z.c aaaaaaaa
```

### Example Two

Input:

```text
1 1
main.c 01234567
gcc wasi o0 abcdef12 0
```

Output:

```text
gcc wasi o0 abcdef12 0
```

### Example Three

Input:

```text
2 2
b.c 11111111
a.c 22222222
cc x o3 aaaaaaaa 2 1 2
cc y o1 bbbbbbbb 1 1
```

Output:

```text
cc x o3 aaaaaaaa 2 a.c 22222222 b.c 11111111
cc y o1 bbbbbbbb 1 b.c 11111111
```

<!-- END GENERATED SAMPLES -->
