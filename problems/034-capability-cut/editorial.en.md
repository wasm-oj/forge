# Editorial

## Intuitive Approach

Enumerate every set of blocked functions, remove it, and test reachability from all entries. This requires `O(2^N(N + M))` time.

## Optimal Approach: Node Splitting and Minimum Cut

Split every function `i` into `in(i)` and `out(i)`, connected by an edge of capacity `cost[i]`. Replace each original call `u -> v` with `out(u) -> in(v)` of capacity `INF`, where `INF = sum(cost) + 1`.

Add a super-source with an `INF` edge to `in(entry)` for every entry. Add an `INF` edge from `out(dangerous)` to the super-sink for every dangerous function. Every source-to-sink path must cross the `in -> out` edge of every function it visits, so cutting such an edge is exactly blocking that function.

Because blocking all functions costs less than `INF`, a minimum cut never uses a synthetic or call edge. Compute a maximum flow with Dinic's algorithm; by the max-flow min-cut theorem, its value is the desired minimum blocking cost.

## Correctness Proof

For any valid blocking set `B`, cut every `in(i) -> out(i)` edge with `i` in `B`. Since the original blocking removes every entry-to-dangerous path, this disconnects the split graph's source and sink with exactly the same cost.

Conversely, a minimum cut cannot contain an `INF` edge: cutting all function edges is a cut of capacity at most `sum(cost) < INF`. Its finite cut edges therefore correspond only to functions. Blocking those functions removes every original entry-to-dangerous path, and its cost equals the cut capacity. These two directions prove equality between the optimal blocking cost and the minimum cut.

Dinic computes a maximum flow, whose value equals that minimum cut. If a function is both entry and dangerous, the constructed path still crosses its own capacity edge, so length-zero dangerous paths are handled correctly.

## Complexity

The split graph has `V' = 2N + 2` vertices and `E' = N + M + S + T` forward edges. The general-capacity Dinic bound is `O(V'^2 E')` time and `O(V' + E')` space.

## Common Mistakes

- Putting node costs on call edges, which charges a function multiple times when it has several incident calls.
- Connecting the source to `out(entry)` or `in(dangerous)` to the sink, which prevents blocking endpoints correctly.
- Choosing an arbitrary fixed infinity without proving it exceeds every finite cut; `sum(cost) + 1` is sufficient.
- Storing capacities in an imprecise numeric type.
