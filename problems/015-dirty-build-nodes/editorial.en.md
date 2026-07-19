# Editorial

## Intuitive Approach

Run a separate DFS from every changed node and union the results. If `visited` is reset for every source, this takes `O(C(N+M))` in the worst case because shared downstream regions are traversed repeatedly.

## Optimal Approach: Multi-Source Reachability

Build the adjacency list in the direction given by the statement. Mark all changed nodes and insert them into one queue. Whenever a node `u` is removed, mark and enqueue each neighbor `v` that is not dirty yet. Finally scan the Boolean array by ID to produce sorted output. This is multi-source BFS; DFS with one shared visited array has the same complexity.

## Correctness Proof

Every changed node is initially marked dirty, matching reachability by a path of zero edges. Whenever the search traverses an edge from dirty `u` to `v`, node `v` directly depends on a dirty artifact and is therefore correctly marked. Conversely, for every node `x` that should be dirty, some changed node has a path to `x`. Induction on path length shows that when each predecessor is processed, the next node is marked, so `x` is eventually marked. Thus the marked set is exactly the union of all downstream reachable nodes. Scanning by ID changes only output order, not the set.

## Complexity

Every node enters the queue at most once and every edge is examined at most once. Time is `O(N+M)` and space is `O(N+M)`.

## Common Mistakes

- Reversing edges and finding dependencies instead of users.
- Forgetting that a changed node itself is dirty.
- Resetting `visited` for every source and losing the benefit of multi-source search.
- Omitting the second newline when `C=0`.
