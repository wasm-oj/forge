# Editorial

## Intuitive Approach: Sort Every Prefix

After cost `i` arrives, sort all first `i` records by descending cost and ascending index, then select record `K`. This takes `O(N^2 log N)` total time and `O(N)` space, so it works only for small inputs.

## Improved Approach: Maintain the Full Ordered Set

Use an order-statistic balanced search tree, or maintain the best `K` records and all remaining records as two ordered sets. Insertion and rebalancing take `O(log N)`, and the boundary of the two sets gives rank `K` immediately. Total time is `O(N log N)` and space is `O(N)`.

## Optimal Approach: Fixed-Size Heap

Retain only the best `K` records seen so far. A record is better when its cost is higher, or when its index is smaller at equal cost. Arrange the heap so that its root is the worst selected record—the current rank `K`.

Insert directly while the heap is not full. Once it is full, a new record no better than the root cannot enter the top `K`; a better record replaces the root and the heap is repaired. Starting at case `K`, the root after each update is exactly the prefix's `K`-th slowest case and can be emitted immediately.

## Correctness Proof

We prove by induction that after every prefix the heap contains exactly the best `min(i,K)` records of that prefix and its root is the worst selected record.

While the heap is not full, every prefix record is inserted, so the claim holds. With a full heap, a new record no better than the root cannot displace any current top-`K` record, so the selected set stays correct. A better new record produces the new top `K` by replacing exactly the old set's worst member. Heap repair keeps that worst selected member at the root. Thus the claim holds for every prefix; whenever `i >= K`, the root is the required rank-`K` record.

## Complexity

Each case performs at most one `O(log K)` insertion or replacement, for `O(N log K)` total time, plus `O(N-K+1)` output. The heap uses `O(K)` working space. Languages that buffer all stdin or output have an actual resident bound of `O(N+K)`.

## Common Mistakes

- Printing only the final prefix answer instead of all `N-K+1` answers.
- Ranking the larger index first when costs tie.
- Putting the globally slowest record at the root instead of the worst selected rank-`K` record.
- Replacing the root even when the new record is not better.
- Storing costs up to `10^12` in 32-bit integers.
