# Editorial

## Intuitive Approach

Insert each retained record into its position in an already sorted manifest. An insertion may shift the entire suffix, so reverse-sorted input takes `O(N^2)` operations in addition to reading the text.

## Optimal Approach: Filter Then Sort

For each record, exclude it exactly when `path == E` or when `path` starts with `E + "/"`. Including the slash in the second condition enforces the path-segment boundary and keeps paths such as `proof2` when `E` is `proof`.

Store each retained record together with its path and unchanged output representation. Sort the retained records by bytewise path order, then emit them in that order.

## Correctness Proof

The filtering predicate is identical to the definition of the evidence subtree, so it excludes every record in that subtree and no record outside it. All input paths are distinct; therefore sorting the retained paths by byte order produces one unique strictly increasing sequence. Finally, the algorithm outputs the stored original record for every retained path, so it changes neither its type nor any associated field. Hence the emitted manifest is exactly the required canonical manifest.

## Complexity

Let `L` be the total number of input characters. Filtering costs `O(L)`. Sorting performs `O(N log N)` path comparisons, and storage is `O(N + L)`. In the comparison model, sorting arbitrary distinct ASCII paths has an `Omega(N log N)` comparison lower bound.

## Common Mistakes

- Using `startsWith(E)` without a segment boundary and incorrectly deleting `proof2`.
- Sorting by record type instead of path.
- Using locale-sensitive collation instead of byte order.
- Reconstructing records and losing the executable bit or symbolic-link target.
