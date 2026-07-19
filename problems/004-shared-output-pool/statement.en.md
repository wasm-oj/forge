# Three-Stream Shared Output Pool

The judge receives `N` write events in chronological order. Each event writes to `O` (stdout), `E` (stderr), or `F` (the output-file collection), but all three destinations share one byte budget.

For every independent query, replay all events from an empty pool. A write may be retained partially: if only `x` bytes remain, retain the first `x` bytes of that event, fill the pool, and record this event as the first failure. Once the pool is full, later events are not processed.

The input guarantees that query budgets are nondecreasing. Output the first event that cannot be retained in full and the number of bytes actually retained for each stream.

## Input

The first line contains `N Q`. The next `N` lines each contain `stream bytes`, where `stream` is `O`, `E`, or `F`. The final `Q` lines each contain one `budget`, in nondecreasing order.

## Output

For every query, output:

```text
failure stdoutBytes stderrBytes fileBytes
```

`failure` is the 1-based index of the first event that cannot be retained completely. If every event is retained completely, `failure=0`. For a zero budget, the first positive-length event fails immediately and all three counts are zero. Repeated budgets are valid and produce identical answers.

## Constraints

- `1 ≤ N,Q ≤ 200000`
- `1 ≤ bytes ≤ 10^12`
- `0 ≤ budget ≤ 9×10^18`
- The sum of bytes over all events is at most `9×10^18`.
- The budget sequence is nondecreasing.

The full constraints rule out replaying all events for every budget.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 6
O 5
E 3
F 10
O 4
0
5
7
8
20
30
```

Output:

```text
1 0 0 0
2 5 0 0
2 5 2 0
3 5 3 0
4 7 3 10
0 9 3 10
```

### Example Two

Input:

```text
1 3
F 7
6
7
8
```

Output:

```text
1 0 0 6
0 0 0 7
0 0 0 7
```

### Example Three

Input:

```text
3 5
E 2
E 2
O 1
1
1
3
4
5
```

Output:

```text
1 0 1 0
1 0 1 0
2 0 3 0
3 0 4 0
0 1 4 0
```

<!-- END GENERATED SAMPLES -->
