# Editorial

## Intuitive Approach

Enumerate subsets of links, test connectivity, and retain the cheapest feasible subset. This is exponential; restricting enumeration to `N - 1` links is still infeasible.

## Optimal Approach: Kruskal's Algorithm

If a feasible connected subgraph contains a cycle, one edge on that cycle can be removed without disconnecting it. Since all costs are nonnegative, removal cannot increase the cost. Therefore some optimum is a spanning tree, and the problem is exactly a minimum spanning tree problem.

Sort links by nondecreasing cost. A disjoint-set union structure tracks current components. Accept an edge precisely when its endpoints are in different components, then unite them. Stop after accepting `N - 1` edges. If fewer than `N - 1` can be accepted, the graph is disconnected. Equal-cost edge order does not affect the minimum total, and no edge-set tie-break is required.

## Correctness Proof

At every step, Kruskal chooses a globally lightest edge joining two current components. For the cut separating those components, the cut property guarantees an MST containing such a lightest edge. Thus, inductively, all accepted edges can be extended to an MST. Once `N - 1` edges have been accepted, they are acyclic by the DSU test and connect all vertices, so they form a minimum-cost spanning tree.

If the scan ends earlier, at least two final components have no edge between them; otherwise that edge would have joined them. No spanning tree exists, so `IMPOSSIBLE` is correct.

## Complexity

Sorting takes `O(M log M)` time. DSU operations take `O(M alpha(N))` total time. Storage is `O(N + M)`.

## Common Mistakes

- Requiring every host to connect directly to host 1.
- Keeping the first parallel edge instead of allowing the cheapest useful one.
- Accumulating the MST cost in a 32-bit integer.
- Forgetting that `N = 1` is already connected even when `M = 0`.
