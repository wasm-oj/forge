# Editorial

## Intuitive Approach

Store every path in an array, but rescan all `P` entries before every operation that may change a size or inode count. This makes transaction validation simple but costs `O(PN)` time.

## Optimal Approach: Incremental Ledger

Maintain `exists[x]`, `size[x]`, `usedBytes`, and `usedInodes`. `CREATE` and `UNLINK` change the inode count by one. When a file changes from `old` to `new`, inspect only the difference: before growth by `delta=new-old`, check `delta≤B-usedBytes`; shrinking releases `old-new` immediately. This comparison also avoids overflow in `usedBytes+delta`.

Perform every check before committing any affected field. After a successful commit, update both peaks independently. On a quota error, set the sticky bit but do not modify the file ledger.

## Correctness Proof

Induct on the number of processed operations. Initially, the arrays and both usage totals represent the empty VFS. Assume the ledger is correct before an operation. For `CREATE` and `UNLINK`, the algorithm checks existence and inode quota in the prescribed order and, on success, adds or removes exactly that file and its size. For `WRITE` and `TRUNCATE`, the computed `new` is exactly the specified size; its difference from `old` is the only change to total logical bytes, so the quota test is necessary and sufficient. Failure branches commit nothing, while success branches commit every affected field together, establishing transaction semantics. Peaks are updated only from true committed usage, and the sticky bit becomes and remains one exactly after either quota error. Thus all operation results and the final summary are correct.

## Complexity

Array initialization takes `O(P)` and each operation takes `O(1)`, for `O(P+N)` total time and `O(P)` core auxiliary space. Including buffered I/O allocations, the common worst-case bound of the seven references is `O(P+N)`. Initialization and reading all operations already impose an `Ω(P+N)` time lower bound.

## Common Mistakes

- Changing a file size before a quota check succeeds, breaking atomicity.
- Adding only `length` for a sparse write and ignoring the hole created by `offset`.
- Extending a file to `offset` on a zero-length write.
- Failing to release both bytes and an inode on `UNLINK`.
- Setting sticky on `EXISTS`/`NOENT`, or clearing it after usage shrinks.
