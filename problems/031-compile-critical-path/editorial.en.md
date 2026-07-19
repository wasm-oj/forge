# Editorial

## Intuitive Approach

Run a DFS from every source, enumerate all source-to-sink paths, and compute each path's duration. This is direct but infeasible: repeated diamond dependencies can create exponentially many distinct paths even in a modest graph.

## Optimal Approach: Longest-Path DP on a Topological Order

Use Kahn's algorithm to obtain a topological order. For each stage `v`, maintain:

- `best[v]`: the maximum duration of a path from any source to `v`;
- `ways[v]`: the number of such paths attaining `best[v]`, modulo `1,000,000,007`.

Initialize every source with `best[v] = d_v` and `ways[v] = 1`. Process each edge `u -> v` in topological order and form `candidate = best[u] + d_v`:

- if `candidate > best[v]`, replace `best[v]` and set `ways[v] = ways[u]`;
- if `candidate == best[v]`, add `ways[u]` to `ways[v]` modulo the modulus;
- otherwise ignore the candidate.

Finally inspect only sinks. The largest sink value is the earliest project completion time. Sum `ways[v]` over all sinks attaining that value.

## Correctness Proof

Proceed by induction over the topological order. A source has exactly one source-to-itself path, of duration `d_v`, so its initialization is correct. Before a non-source `v` is processed, all its predecessors have already been processed. Every source-to-`v` path consists of a source-to-`u` path for exactly one incoming edge `u -> v`, followed by `v`. The transitions compare all such candidates, retain precisely the maximum duration, and add counts only for candidates attaining that maximum. Thus `best[v]` and `ways[v]` satisfy their definitions.

Every complete pipeline ends at a sink, and every source-to-sink path is complete. Taking the maximum over sinks and summing the counts for tied sinks therefore yields exactly the required completion time and number of critical pipelines.

## Complexity

Path enumeration can require `O(2^N + M)` time and `O(N + M)` space. The topological DP processes every vertex and edge a constant number of times, using `O(N + M)` time and `O(N + M)` space.

## Common Mistakes

- Initializing every vertex as a source and counting paths that do not begin at a source.
- Taking the final maximum over all vertices instead of sinks only.
- Failing to add path counts on equal-duration transitions or to apply the modulus.
- Storing path durations in 32-bit integers.
