# Editorial

## Intuitive Approach

Let `L` be the total path length in bytes and `Z` the actual output size. Copying and sorting all files for every query, then simulating collection, costs `O(QL log N+Z)`. Sorting once but scanning from the beginning for every budget can still cost `O(L log N+NQ+Z)`. Prefix sums with a binary search per query achieve `O(L log N+Q log N+Z)`.

## Optimal Approach: One Sort and a Monotone Capacity Pointer

Sort files by path, compute the prefix sums `prefix` of metadata lengths, and record the first mismatch index `m`, using `m=N` if none exists. Because budgets are nondecreasing, maintain `k`, the maximum number of prefix files whose metadata sum fits within `budget-U`. Advance `k` with a while loop; across all queries it advances at most `N` times.

Check cases in this order after first handling `U>budget`:

- If `k<m`, the normal file at index `k` is the first one that does not fit: output its `QUOTA` error.
- If `m<N`, every preceding normal file fits, and processing file `m` produces `MISMATCH`.
- If `k<N`, no mismatch exists, but file `k` does not fit.
- Otherwise all files succeed, with final usage `U+prefix[N]`.

## Correctness Proof

The prefix sums are nondecreasing, and the maximum affordable prefix length is nondecreasing with the budget. Thus after advancing, `k` is exactly the largest prefix that fits when mismatches are ignored. If `k<m`, the first `k` normal files fit and file `k` exceeds quota, making it the earliest error. If `k≥m` and a mismatch exists, every earlier normal file fits; at `m`, the required check order reports `MISMATCH` even if that file would also exceed quota. With no mismatch, `k<N` identifies the first quota failure and `k=N` means complete success. These cases are mutually exclusive and exhaustive, so every answer is correct.

## Complexity

Comparison sorting performs `O(N log N)` string comparisons; accounting for variable-length path bytes gives a portable worst-case bound of `O(L log N)`. Preprocessing is `O(N)`, and the pointer advances `O(N)` times over all queries. Including output, total time is `O(L log N+Q+Z)`. Stored paths, prefix sums, and buffered I/O use `O(L+N+Z)` worst-case space. Canonical comparison sorting requires `Ω(N log N)` comparisons, while reading paths, answering queries, and writing output require `Ω(L)`, `Ω(Q)`, and `Ω(Z)` respectively; the monotone query phase is therefore linear and optimal.

## Common Mistakes

- Collecting in input order instead of bytewise path order.
- Checking quota before mismatch on the same file.
- Returning files processed before an error as partial success.
- Forgetting that `U` already consumes budget, or naming a path when `U>budget`.
- Treating the pointer as committed side effects instead of a static affordable prefix, breaking repeated budgets.
- Writing only `O(N log N)` and omitting the byte cost of variable-length path comparisons.
