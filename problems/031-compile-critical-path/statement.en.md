# Compile Pipeline Critical Path

A project's build consists of `N` stages. Stage `i` takes `d_i` units of time. A dependency `u v` means that stage `v` cannot start until stage `u` has finished.

The dependencies form a directed acyclic graph. There are infinitely many workers, so every stage whose dependencies are satisfied may run concurrently. A stage with no predecessor starts at time `0`.

A complete pipeline is a directed path from a stage with indegree zero to a stage with outdegree zero. The project's earliest completion time is the maximum sum of stage durations along any complete pipeline. Output that completion time and the number of complete pipelines attaining it, modulo `1,000,000,007`.

Two pipelines are different exactly when their stage sequences differ. An isolated stage is both a source and a sink and therefore forms a complete pipeline by itself.

## Input

The first line contains `N M`.

The second line contains `N` integers `d_1 ... d_N`.

Each of the next `M` lines contains `u v`, denoting a directed dependency from `u` to `v`. There are no duplicate edges or self-loops.

## Output

Output two integers: the earliest completion time and the number of complete pipelines attaining that time, modulo `1,000,000,007`.

## Constraints

- `1 <= N <= 200000`
- `0 <= M <= 400000`
- `1 <= d_i <= 10^9`
- The sum of all stage durations is at most `9 * 10^18`.
- The input graph is a DAG.
- Stage IDs are 1-based.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 4
2 3 3 4
1 2
1 3
2 4
3 4

```

Output:

```text
9 2
```

### Example Two

Input:

```text
3 0
5 5 1

```

Output:

```text
5 2
```

### Example Three

Input:

```text
3 2
1 2 3
1 2
2 3

```

Output:

```text
6 1
```

<!-- END GENERATED SAMPLES -->
