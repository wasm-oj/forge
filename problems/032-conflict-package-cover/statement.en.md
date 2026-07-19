# Minimum Conflict Package Isolation

A runtime contains two kinds of packages: npm packages on the left and native packages on the right. Each conflict edge means that its two endpoints cannot both remain available. Isolating a package removes every conflict incident to it.

Find the minimum number of packages that must be isolated to eliminate all conflicts. Output only the minimum size; an optimal set need not be unique.

## Input

The first line contains `L R M`. Each of the next `M` lines contains `u v`, where `u` is a 1-based left-side package ID and `v` is a 1-based right-side package ID.

## Output

Output one integer: the minimum number of vertices required to cover every conflict edge. If `M = 0`, output `0`.

## Constraints

- `1 <= L, R <= 200000`
- `0 <= M <= 400000`
- There are no duplicate edges.
- Full tests include layered graphs on which one augmenting search per left vertex takes `Theta(LM)`; a layered augmenting-path algorithm is required.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 3 3
1 1
2 2
3 3
```

Output:

```text
3
```

### Example Two

Input:

```text
1 4 4
1 1
1 2
1 3
1 4
```

Output:

```text
1
```

### Example Three

Input:

```text
4 5 0
```

Output:

```text
0
```

<!-- END GENERATED SAMPLES -->
