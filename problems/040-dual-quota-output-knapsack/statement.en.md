# Dual-Quota Output Collection

A submission produces `N` optional output bundles. Bundle `i` consumes `bytes_i` bytes of shared output space and `entries_i` VFS entries, and has diagnostic importance `value_i`. Bundles are indivisible and cannot be selected more than once.

The system permits at most `B` bytes and `I` entries. Choose any subset that stays within both quotas and maximizes total importance. The empty subset is valid. Output only the maximum importance, not the subset.

## Input

The first line contains `N B I`. Each of the next `N` lines contains `bytes_i entries_i value_i`.

## Output

Output one line containing the maximum total importance.

## Constraints

- `1 <= N <= 100`
- `0 <= B <= 3000`
- `0 <= I <= 30`
- `0 <= bytes_i <= 3000`
- `1 <= entries_i <= 30`
- `0 <= value_i <= 10^12`
- The sum of all values is at most `9 * 10^18`.

An empty bundle with zero bytes still consumes at least one entry. The full limits and the 64 MiB memory limit rule out subset enumeration and a full three-dimensional table retaining the item dimension.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 7 3
4 1 8
3 2 7
2 1 5
5 3 20
```

Output:

```text
20
```

### Example Two

Input:

```text
4 0 2
0 1 5
0 1 7
0 2 9
1 1 100
```

Output:

```text
12
```

### Example Three

Input:

```text
5 10 4
6 2 12
4 2 9
5 1 10
3 3 8
10 4 25
```

Output:

```text
25
```

<!-- END GENERATED SAMPLES -->
