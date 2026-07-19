# Cutting Dangerous Capabilities

A function call graph is directed. If any dangerous function is reachable from any public entry function, the sandbox may reach a network, thread, or process capability.

You may block function `i` at cost `cost[i]`. Blocking removes the function and every incident call edge. Entry functions and dangerous functions may also be blocked. Find the minimum total cost that eliminates every path from every entry to every dangerous function.

## Input

The first line contains `N M S T`. The second line contains the `N` function costs. The third line contains `S` distinct entry IDs, and the fourth line contains `T` distinct dangerous IDs. Each of the next `M` lines contains a directed edge `u v`, meaning that `u` can call `v` directly.

All sets use 1-based IDs. The entry and dangerous sets may overlap. An overlapping function forms a dangerous path of length zero unless that function is blocked.

## Output

Output `COST x`. If no dangerous path exists initially, `x = 0`. An optimal blocking set need not be unique, so do not output the set.

## Constraints

- `1 <= N <= 500`
- `0 <= M <= 5000`
- `1 <= S, T <= N`
- Edges have no self-loops or duplicates.
- `0 <= cost[i] <= 10^12`
- The sum of all costs is at most `8 * 10^18`.
- Every flow and cut value fits in an unsigned 64-bit integer.
- Full tests rule out enumerating function subsets; node costs must be transformed into cut capacities.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 2 1 1
5 2 7
1
3
1 2
2 3
```

Output:

```text
COST 2
```

### Example Two

Input:

```text
4 4 1 1
10 2 3 10
1
4
1 2
2 4
1 3
3 4
```

Output:

```text
COST 5
```

### Example Three

Input:

```text
4 2 1 1
1 1 1 1
1
4
1 2
3 4
```

Output:

```text
COST 0
```

<!-- END GENERATED SAMPLES -->
