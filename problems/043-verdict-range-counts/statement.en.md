# Verdict Range Counts

A contest stores `N` case verdicts by index. Every character is `A` (Accepted), `W` (Wrong Answer), `R` (Runtime Error), or `T` (Time Limit).

Answer `Q` static range queries. A query `L R V` asks how many times verdict `V` occurs in the closed interval `[L, R]`. Indices are one-based, and the record never changes between queries.

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
