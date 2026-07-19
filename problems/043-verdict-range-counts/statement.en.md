# Verdict Range Counts

While designing the verdict-analysis interface for a WASM OJ, we wanted users to inspect the failure distribution within any consecutive group of tests quickly. For example, they may want to count Runtime Errors only in the stress-test section or compare the number of Wrong Answers between two groups of cases.

One submission has already recorded `N` verdicts by case index. Each verdict is represented by one character: `A` for Accepted, `W` for Wrong Answer, `R` for Runtime Error, or `T` for Time Limit. This record does not change while it is being analyzed.

Answer `Q` static range queries. A query `L R V` asks how many times verdict `V` occurs in the closed interval `[L, R]`. All indices are one-based.

## Input

The first line contains `N Q`. The second line is a verdict string of length `N`. Each of the next `Q` lines contains `L R V`.

## Output

Output one count per query.

## Constraints

- `1 <= N, Q <= 200000`
- The verdict string and query characters contain only `A`, `W`, `R`, and `T`.
- `1 <= L <= R <= N`

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
8 4
AAWRTWAA
1 8 A
3 6 W
4 7 R
5 5 T
```

Output:

```text
4
2
1
1
```

### Example Two

Input:

```text
5 3
WWWWW
1 5 A
2 4 W
3 3 W
```

Output:

```text
0
3
1
```

### Example Three

Input:

```text
4 4
ARTW
1 1 A
1 4 T
2 3 W
2 2 R
```

Output:

```text
1
1
0
1
```

<!-- END GENERATED SAMPLES -->
