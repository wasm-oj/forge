# Browser Storage Evacuation

The cache currently contains `N` indivisible items. Its logical limit is `C` bytes. The browser currently has `A` bytes available, and the system requires at least `R` available bytes to remain.

If total item size is `T`, at least

`need = max(0, T - C, R - A)`

bytes must be freed. If `need` exceeds `T`, evacuation is impossible.

Each item has `size priority lastUsed participant key`. The fixed eviction order is:

1. lower `priority` first;
2. for equal priority, lower (older) `lastUsed` first;
3. then ASCII-lexicographically smaller `participant`;
4. finally ASCII-lexicographically smaller `key`.

Delete complete items in this order until the freed amount first reaches or exceeds `need`. This order is policy; you may not choose a different combination that sums exactly to the target.

## Input

The first line contains `N C A R`, followed by `N` item lines.

## Output

If evacuation is impossible, output `IMPOSSIBLE`. Otherwise output `k freed` on the first line, then output `k` lines containing `participant key` in eviction order. When no deletion is needed, output `0 0` and no subsequent lines.

## Constraints

- `1 ≤ N ≤ 200000`
- `0 ≤ C,A,R,size,lastUsed ≤ 10^18`
- `1 ≤ size`
- The sum of all sizes is at most `9×10^18`.
- `0 ≤ priority ≤ 10^9`
- `participant` and `key` contain `1..20` lowercase alphanumeric characters.
- Every `(participant,key)` pair is unique.
- The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 100 30 50
40 2 10 alpha a
30 1 20 beta b
50 1 5 alpha c
10 1 5 alpha b
```

Output:

```text
2 60
alpha b
alpha c
```

### Example Two

Input:

```text
2 100 100 20
10 0 1 p a
20 1 2 p b
```

Output:

```text
0 0
```

### Example Three

Input:

```text
2 100 0 1000
10 0 1 p a
20 1 2 p b
```

Output:

```text
IMPOSSIBLE
```

<!-- END GENERATED SAMPLES -->
