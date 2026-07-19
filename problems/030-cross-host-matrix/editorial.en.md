# Editorial

## Intuitive Approach

For every baseline path, linearly search the other field list, then search in the opposite direction for missing paths. A single large case can make this `O(T^2)`.

## Optimal Approach: Merge Sorted Fields

First compare the complete case-ID vectors. If they differ, emit `CASE_ORDER` immediately for that host.

Otherwise, process corresponding cases in baseline order. Their field lists are already sorted, so merge them with two pointers. If one current path is smaller, it exists only on that side and is a difference. If the paths are equal, compare their values and advance both pointers. Appending the remaining suffix handles paths that exist on only one side. Processing cases and paths in this order directly produces the required output order.

Only if every transcript matches, collect the `H` runtimes for each case, sort them, and select element `(H - 1) / 2` using integer division.

## Correctness Proof

Direct comparison of the case-ID vectors accepts exactly when both their lengths and every ordered ID agree, which proves the first-level classification.

For a pair of field lists, maintain the invariant that every path before either pointer has been classified exactly once and that the smallest unclassified path is at one of the pointers. Taking the smaller path, or the common path when equal, classifies that path correctly and preserves the invariant. Thus the merge finds exactly the union of missing and unequal-valued paths without duplicates, in sorted order. Baseline case order then gives the full required difference order.

If every host is `OK`, sorting the `H` runtimes and selecting zero-based index `floor((H - 1) / 2)` is exactly the defined lower median. Median lines are emitted only in this all-consistent case, so the complete output is correct.

## Complexity

Let `T` be the total number of case and field records, `D` the number of printed difference paths, and `C` the baseline case count. Shared fields are charged to `T`; a baseline-only field rescanned for different hosts produces a difference each time and is charged to `D`. Comparisons therefore take `O(T + D)`, and median sorting takes `O(CH log H)`. The reference implementations store the input and may buffer output, using `O(T + D + H)` space. The bound `D <= 200000` prevents valid output from growing impractically relative to the input.

## Common Mistakes

- Treating cases as a set and ignoring their order.
- Detecting changed values but missing paths present on only one side.
- Printing medians after any transcript mismatch.
- Taking the upper median when `H` is even.
