# Compile Pipeline Critical Path

While designing the in-browser compiler for a WASM OJ, we wanted to estimate the earliest time a project could finish building before actually starting the build. Compilation jobs often depend on one another, but jobs whose prerequisites are complete can be assigned to different workers and run concurrently.

To focus on the dependency structure itself, we use an idealized system with infinitely many workers. The project contains `N` stages, and stage `i` takes `d_i` units of time. A dependency `u v` means that stage `v` cannot start until stage `u` has finished. The dependency graph is guaranteed to be a directed acyclic graph, and every stage with no predecessor starts at time `0`.

Besides the earliest completion time, we want to know how many distinct critical build pipelines determine that time, because each such pipeline is a bottleneck worth examining when improving the scheduler. A complete pipeline is a directed path from a stage with indegree zero to a stage with outdegree zero. The project's earliest completion time is the maximum sum of stage durations along any complete pipeline.

Output the earliest completion time and the number of complete pipelines attaining it, modulo `1,000,000,007`. Two pipelines are the same exactly when their stage sequences are identical. An isolated stage is both a source and a sink, so it forms a complete pipeline by itself.

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
