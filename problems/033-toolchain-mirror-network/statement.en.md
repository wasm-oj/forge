# Toolchain Mirror Network

While designing a distributed WASM OJ, we needed every execution host to receive the same compiler toolchain. Having every host download directly from central storage would duplicate bandwidth and could turn one source into a deployment bottleneck, so we allow a host that already has the toolchain to forward it to another host.

Transfer costs differ between hosts: some links stay within one data center, while others cross regions. Initially only host `1` has the toolchain. We must first choose which transfer links to use and can then distribute the toolchain in any feasible order.

An undirected link `u v cost` can transfer the toolchain once between its two hosts. As soon as either endpoint has the toolchain, the selected link can give it to the other endpoint. After the links are selected, transfers may occur in any order reachable from host `1`.

Choose links so that every host eventually receives the toolchain while minimizing the total cost of the selected links. Equivalently, the selected links must form a connected subgraph spanning every host.

## Input

The first line contains `N M`. Each of the next `M` lines contains `u v cost`. Host IDs are 1-based and links are undirected.

## Output

If it is impossible to connect every host, output `IMPOSSIBLE`. Otherwise output `COST x`, where `x` is the minimum total cost. When `N = 1`, output `COST 0` regardless of the links.

## Constraints

- `1 <= N <= 200000`
- `0 <= M <= 400000`
- `u != v`; parallel links are allowed.
- `0 <= cost <= 10^12`
- The total cost of any spanning tree is at most `9 * 10^18`.
- Full tests require sublinear amortized DSU operations; subset enumeration and adjacency-matrix Prim cannot pass.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 5
1 2 4
2 3 1
3 4 2
1 4 10
1 3 3
```

Output:

```text
COST 6
```

### Example Two

Input:

```text
4 2
1 2 1
3 4 1
```

Output:

```text
IMPOSSIBLE
```

### Example Three

Input:

```text
3 4
1 2 9
1 2 0
2 3 4
1 3 8
```

Output:

```text
COST 4
```

<!-- END GENERATED SAMPLES -->
