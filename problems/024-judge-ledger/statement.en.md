# Judge Ledger Range Queries

Each case records `verdict cost time memory vfs` in sequence. Verdict is encoded as an integer: `0=AC, 1=WA, 2=RE, 3=TLE`. A metric that is unavailable is represented by `-1`.

Each query `l r f` aggregates the 1-indexed closed interval `[l,r]`:

- If `f=1` (fail-fast), process only through the first case in the interval whose verdict is nonzero, including that case. If no case fails, process through `r`.
- If `f=0`, process the entire interval.
- The output verdict is the first nonzero verdict in the range actually processed, or 0 if none exists.
- Sum `cost` and `time`; take the maximum of `memory` and `vfs`.
- Handle every metric independently. If any value for one metric is `-1` in the actual range, output `null` for that aggregate. Other metrics are unaffected.

## Input

The first line contains `N Q`. The next `N` lines contain cases, followed by `Q` query lines.

## Output

For every query, output `processed verdict cost time memory vfs`. `processed` is the number of cases in the actual processed range.

## Constraints

- `1 ≤ N,Q ≤ 200000`
- Every metric is `-1` or lies in `[0,10^12]`.
- The cost or time sum of any valid interval is at most `9×10^18`.
- `1 ≤ l ≤ r ≤ N`
- `f` is 0 or 1.
- The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 4
0 10 5 100 3
1 20 7 120 4
0 -1 2 80 2
2 5 -1 200 -1
1 4 1
1 4 0
3 4 1
3 3 0
```

Output:

```text
2 1 30 12 120 4
4 1 null null 200 null
2 2 null null 200 null
1 0 null 2 80 2
```

### Example Two

Input:

```text
3 3
0 1 2 3 4
0 5 6 7 8
0 9 10 11 12
1 3 1
2 3 0
2 2 1
```

Output:

```text
3 0 15 18 11 12
2 0 14 16 11 12
1 0 5 6 7 8
```

### Example Three

Input:

```text
2 2
3 -1 -1 -1 -1
0 7 8 9 10
1 2 1
1 2 0
```

Output:

```text
1 3 null null null null
2 3 null null null null
```

<!-- END GENERATED SAMPLES -->
