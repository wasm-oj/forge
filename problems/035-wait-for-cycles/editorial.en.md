# Editorial

## Intuitive Approach

Run a graph search from every process, construct pairwise mutual reachability, and group equivalent vertices. This takes `O(N(N + M))` time; Floyd-Warshall is even worse at `O(N^3)`.

## Optimal Approach: SCCs and the Condensation DAG

Use iterative Kosaraju. The first traversal of the original graph uses explicit `(node, next-edge-index)` stack frames to produce finishing order. The second traversal follows reverse finishing order on the reversed graph and assigns an SCC ID to every process. Explicit stacks avoid recursion overflow on long chains.

Collect the members of each SCC. It is a wait-cycle group exactly when it has more than one member or contains a self-loop. For every edge crossing from component `cu` to component `cv`, mark `cv` as having positive condensation indegree.

The condensation graph is a DAG. One wake in an SCC releases that entire SCC and everything reachable downstream. Therefore the minimum number `W` is the number of condensation SCCs with indegree zero.

Scan process IDs in increasing order when appending them to their components. This makes IDs inside each component sorted and allows components to be emitted in increasing order of their first member without an extra comparison sort.

## Correctness Proof

Kosaraju's theorem guarantees that the two traversals partition the graph into exactly its maximal mutually reachable sets. An SCC of size greater than one contains a directed cycle; a singleton contains a cycle exactly when it has a self-loop. Thus the reported wait-cycle groups are exactly the required groups, and sorting affects only their canonical output order.

After contraction, every source SCC has no incoming edge from another SCC, so no wake outside it can release it. Every valid plan therefore needs at least one wake in each source SCC. Conversely, waking one process in each source SCC releases each such SCC, and every SCC in a finite DAG is reachable from some source. Release propagation consequently reaches every process. The lower and upper bounds coincide, so `W` is correct.

## Complexity

The two DFS passes and the condensation scan take `O(N + M)` time. Building membership lists and producing canonical order can also be done in one increasing-ID scan. Total space is `O(N + M)`.

## Common Mistakes

- Treating every singleton SCC as cyclic without checking for a self-loop.
- Counting condensation sinks instead of sources; release propagates in the edge direction.
- Treating duplicate condensation edges as meaningful exact indegree counts when only zero versus nonzero matters.
- Using recursive DFS on a chain of `200000` vertices.
