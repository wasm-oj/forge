# Editorial

## Intuitive Approach

Repeatedly scan all unbuilt packages for the lexicographically smallest one with indegree zero. Even if every edge is updated only once, finding the minimum takes `O(N^2)` time.

## Optimal Approach: Kahn's Algorithm with a Name Min-Heap

Sort `(name,ID)` by name. While reading an edge, find both IDs by binary search and remember the first edge with an unknown endpoint. If any dangling edge exists, report it immediately as required. For a legal relation `a depends b`, create edge `b -> a` and increment `indegree[a]`. This comparison-based lookup gives deterministic worst-case bounds in every reference language without relying on expected hash-table behavior.

Insert all indegree-zero IDs into a min-heap ordered by package name. Repeatedly pop and output the minimum, decrement every downstream indegree, and push a downstream package when its indegree becomes zero. If fewer than `N` packages are output, report a cycle.

## Correctness Proof

If a dangling edge is reported, the stored edge has the smallest input index among all unknown endpoints, so it satisfies the highest-priority error. Now assume no dangling edge. Maintain the Kahn invariant that the heap contains exactly all unbuilt nodes of indegree zero. It holds initially. Popping a node removes exactly its outgoing edges, adding a downstream node precisely when its last unbuilt dependency disappears, so the invariant is preserved. At each step, the heap minimum is exactly the lexicographically smallest ready package, making a successful order uniquely correct. If processing stops early, Kahn's theorem guarantees a directed cycle among or blocking the remaining nodes; conversely, a DAG always has another indegree-zero node. Thus cycle detection is also correct.

## Complexity

Sorting names takes `O(N log N)`. Every edge performs two `O(log N)` binary searches, and each node enters and leaves the heap at most once. Total time is `O((N+M) log N)` and space is `O(N+M)`.

## Common Mistakes

- Building `a -> b` for `a depends b` instead of `b -> a`.
- Using a FIFO queue and producing a valid but noncanonical topological order.
- Reporting a cycle before a higher-priority dangling edge.
- Ordering heap entries by ID rather than package name.
