# Reproducible Package Build Order

An offline toolchain must build packages according to a dependency graph. To make builds reproducible across hosts, whenever several packages have all their dependencies completed, the package with the ASCII-lexicographically smallest name must be chosen.

## Input

The first line contains `N M`. The next `N` lines contain distinct known package names. Each of the following `M` lines contains `a b`, meaning package `a` **depends on** package `b`, so `b` must be built first. An edge may contain a name not present in the known list, representing a corrupt lockfile.

## Output

Errors take priority over building:

1. If a dangling edge exists, output `INVALID DANGLING i`, where `i` is the 1-based index of the first input edge with either endpoint unknown. Do not check for cycles afterward.
2. If no edge is dangling but the graph contains a cycle, output `INVALID CYCLE`.
3. Otherwise output `ORDER p_1 ... p_N`, the unique order produced by the selection rule.

## Constraints

- `1 ≤ N ≤ 200000`
- `0 ≤ M ≤ 400000`
- A package name has length `1..30` and contains only lowercase letters, digits, and `-`.
- Known names are distinct; edge pairs are distinct and contain no self-loop.
- Lexicographic comparisons use ASCII bytes, not locale rules.

The full constraints rule out scanning every remaining package linearly at each step.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 2
app
core
util
app core
app util
```

Output:

```text
ORDER core util app
```

### Example Two

Input:

```text
2 1
app
core
app ghost
```

Output:

```text
INVALID DANGLING 1
```

### Example Three

Input:

```text
2 2
a
b
a b
b a
```

Output:

```text
INVALID CYCLE
```

<!-- END GENERATED SAMPLES -->
