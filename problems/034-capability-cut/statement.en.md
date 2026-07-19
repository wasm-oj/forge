# Cutting Dangerous Capabilities

While designing the capability sandbox for a WASM OJ, checking only which APIs a module imports directly was not enough. A public entry function may pass through several helper calls before reaching a function that can create a network connection, thread, or process. If any such call path exists, the user program may still reach a forbidden capability.

We can block selected functions while loading the module, but functions have different blocking costs: some are easy to replace, while disabling others also removes substantial legitimate behavior. The goal is therefore not to block the most functions, but to cut every dangerous path at minimum total cost.

Represent the function call relation as a directed graph. A dangerous path exists if any dangerous function is reachable from any public entry function along call edges. Blocking function `i` costs `cost[i]` and removes that function together with every incident call edge. Public entry functions and dangerous functions themselves may also be blocked.

Find the minimum total cost required to eliminate every path from every entry function to every dangerous function.

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
