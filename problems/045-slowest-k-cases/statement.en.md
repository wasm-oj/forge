# Running K-th Slowest Case

A submission's test cases finish one at a time. When case `i` finishes, the system receives its instruction cost `cost_i`; its case index is `i`.

At every moment `i >= K`, consider only the first `i` cases and output the case ranked `K`-th slowest. Higher cost ranks first; at equal cost, the smaller index ranks first. Each prefix answer is fixed before the next case finishes, and later costs do not belong to earlier prefixes.

## Input

The first line contains `N K`. The second line contains the `N` case costs in completion order.

## Output

For every `i = K, K+1, ..., N`, output one line containing `index cost` for the case ranked `K`-th slowest among the first `i` cases.

## Constraints

- `1 <= N <= 200000`
- `1 <= K <= min(N, 5000)`
- `0 <= cost_i <= 10^12`

The full constraints require answering every prefix and rule out sorting all existing cases again for each prefix.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 3
10 30 30 5 20
```

Output:

```text
1 10
1 10
5 20
```

### Example Two

Input:

```text
4 4
7 7 7 7
```

Output:

```text
4 7
```

### Example Three

Input:

```text
6 1
1 9 3 9 2 8
```

Output:

```text
1 1
2 9
2 9
2 9
2 9
2 9
```

<!-- END GENERATED SAMPLES -->
