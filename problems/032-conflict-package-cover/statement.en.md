# Minimum Conflict Package Isolation

While designing the runtime package environment for a WASM OJ, we needed to combine npm packages from the JavaScript ecosystem with lower-level native packages. Some cross-ecosystem combinations compete for the same symbols, expose incompatible ABIs, or require conflicting runtime capabilities, so both packages in such a pair cannot remain available together.

Resolving conflicts one at a time would miss an important effect: isolating one package removes every conflict involving it. We therefore want an isolation plan that removes as few packages as possible while leaving the remaining packages mutually usable.

Model the `L` npm packages as vertices on the left and the `R` native packages as vertices on the right. Every conflict edge connects one left package to one right package and means that its endpoints cannot both remain available. Isolating either endpoint eliminates that conflict, and isolating a package eliminates all incident conflicts.

Find the minimum number of packages that must be isolated to eliminate every conflict. Output only the minimum size; an optimal set need not be unique, so the set itself is not required.

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
