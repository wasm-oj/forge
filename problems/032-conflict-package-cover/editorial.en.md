# Editorial

## Intuitive Approach

Enumerating package subsets and checking whether every edge is covered is exponential. Kuhn's algorithm is better, but finding one augmenting path independently for each left vertex takes `O(LM)` in the worst case and fails on large layered graphs.

## Optimal Approach: Hopcroft-Karp and Konig's Theorem

The conflict graph is bipartite. Konig's theorem states that the size of a minimum vertex cover in a bipartite graph equals the size of a maximum matching, so it suffices to compute a maximum matching.

In each Hopcroft-Karp phase, start a BFS from all unmatched left vertices. It assigns layers to left vertices and determines the shortest augmenting-path length. Then find a maximal set of vertex-disjoint shortest augmenting paths, following only edges for which the next matched left vertex is one layer deeper.

Maintain an edge cursor for every left vertex during a phase, and invalidate a left vertex after all of its layered choices fail. This prevents repeated scans within the same phase. The reference implementations use explicit `stackU` and `stackV` structures to reconstruct augmenting paths without overflowing the call stack on deep graphs.

The number of successful augmentations is the maximum matching size and, by Konig's theorem, the answer.

## Correctness Proof

BFS layers the alternating graph by shortest augmenting distance. The subsequent searches follow only valid consecutive layers. Whenever an unmatched right vertex is reached, flipping matched and unmatched edges along the recovered path increases the matching size by one and preserves the matching property. Edge cursors and failed-vertex pruning discard only edges already proved unable to complete a layered augmenting path in that phase.

Consequently, after a phase no augmenting path of its shortest length remains. The Hopcroft-Karp theorem guarantees that repeating phases until BFS finds no augmenting path produces a maximum matching. Konig's theorem then equates its size with the minimum bipartite vertex-cover size, which is exactly the minimum number of packages whose isolation removes all conflict edges.

## Complexity

Hopcroft-Karp uses `O(sqrt(L + R))` phases. The implemented loops scan all left vertices and edges per phase and initialize right-side matching state, giving `O((L + R + M) sqrt(L + R))` time and `O(L + R + M)` space. The vertex terms matter when many isolated vertices coexist with a nontrivial component requiring several phases.

## Common Mistakes

- Applying `maximum matching = minimum vertex cover` to a non-bipartite graph.
- Following arbitrary edges after BFS and losing the layered complexity bound.
- Resetting edge cursors for every search and rescanning a phase repeatedly.
- Using recursive augmentation and overflowing the stack on a long alternating path.
