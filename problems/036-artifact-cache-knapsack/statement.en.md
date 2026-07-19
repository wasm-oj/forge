# Artifact Cache Trade-offs

There are `N` independent build artifacts. Artifact `i` consumes `size_i` units of cache and saves `value_i` units of time during the next build if retained. Each artifact may be retained at most once, and the cache has total capacity `C`.

Choose a subset whose total size does not exceed `C` and whose total saved time is maximum. Output only the maximum value, not the subset. The empty subset is always valid.

## Input

The first line contains `N C`. Each of the next `N` lines contains `size_i value_i`.

## Output

Output one line containing the maximum total saved time.

## Constraints

- `1 <= N <= 200`
- `0 <= C <= 100000`
- `1 <= size_i <= 100000`
- `0 <= value_i <= 10^12`
- The sum of all values is at most `9 * 10^18`.

Artifacts are indivisible. An artifact with `size_i > C` can never be selected. The full limits and the 64 MiB memory limit rule out subset enumeration and an `O(NC)`-space table.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 7
6 13
4 8
3 6
5 12
```

Output:

```text
14
```

### Example Two

Input:

```text
3 0
1 100
2 200
3 300
```

Output:

```text
0
```

### Example Three

Input:

```text
5 10
2 4
2 5
6 12
5 11
4 8
```

Output:

```text
21
```

<!-- END GENERATED SAMPLES -->
