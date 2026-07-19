# Dependency-Aware Cache Knapsack

There are `N` cache artifacts forming a dependency forest. Node `i` has direct prerequisite `parent_i`; `parent_i = 0` means it has no prerequisite. Retaining node `i` requires retaining its parent and every ancestor up to the root. A selection without this dependency closure is invalid.

Every node has a cache size and a value. Choose a dependency-closed subset with total size at most `C` and maximum total value. The empty subset is valid. Output only the maximum value.

## Input

The first line contains `N C`. For IDs `1..N`, the next `N` lines contain `parent_i size_i value_i`.

The input guarantees `0 <= parent_i < i`, so the structure is a forest with no cycle. ID order is not necessarily DFS order. Children of the same parent have increasing ID as their fixed order, although this order does not affect the optimum.

## Output

Output one line containing the maximum total value.

## Constraints

- `1 <= N <= 200`
- `0 <= C <= 10000`
- `1 <= size_i <= 10000`
- `0 <= value_i <= 10^12`
- The sum of all values is at most `9 * 10^18`.

Full tests rule out subset enumeration. The intended solution also avoids an `O(C^2)` capacity convolution for every child.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 7
0 2 3
1 3 5
1 4 8
2 2 4
```

Output:

```text
12
```

### Example Two

Input:

```text
3 0
0 1 10
1 1 20
0 1 30
```

Output:

```text
0
```

### Example Three

Input:

```text
3 3
0 5 5
1 1 100
0 2 10
```

Output:

```text
10
```

<!-- END GENERATED SAMPLES -->
