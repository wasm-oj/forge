# Editorial

## Intuitive Approach

For each build, start with an empty array and insert every file ID at its correct position by path. A build with `K` files may require `O(K^2)` comparisons and moves, so a large build times out.

## Optimal Approach: Per-Build Comparison Sort

After reading the file table, collect each build's file IDs and comparison-sort them using the corresponding path as the key. Output the four metadata fields and `K`, then each sorted `(path,digest)` pair. Because all paths are ASCII, ordinary byte/string lexicographic order in each supported language agrees under these constraints.

Do not concatenate the tokens into one giant string only to split it again, and do not compute a digest. Stream output tokens directly, or use a fixed-size 64 KiB chunk buffer, to avoid allocating a string as large as the entire output.

## Correctness Proof

After sorting, adjacent paths are nondecreasing. Because paths are unique, they are strictly increasing, and sorting is a permutation, so the selected file set is unchanged. The algorithm outputs the four metadata fields and `K` verbatim, then retrieves the unique path and digest for every sorted ID. Each line is therefore exactly the specified canonical preimage. Since the canonical order is unique, the output is correct.

## Complexity

Build `i` takes `O(K_i log K_i)` path comparisons and `O(K_i)` temporary space. Let `S` include all text bytes read and written. Total time is `O(sum K_i log K_i + S)`, and peak auxiliary space is `O(K_max)`. The file table and input separately require `O(N+S_input)`; streaming output does not retain `S_output`.

## Common Mistakes

- Sorting by file ID or digest instead of path.
- Sorting the metadata fields.
- Printing a placeholder token when `K=0`.
- Using locale-aware collation and obtaining host-dependent order.
