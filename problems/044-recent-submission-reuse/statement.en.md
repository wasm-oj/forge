# Recent Submission Reuse

A judge receives `N` submissions in chronological order. Submission `i` has a lowercase hexadecimal fingerprint. It is a **reuse hit** if the same exact fingerprint appeared at an index in

```text
[max(1, i - K), i - 1].
```

In other words, only the previous `K` submissions are recent enough. Fingerprints are exact tokens, not hexadecimal numbers, so `0` and `00` are different. When `K = 0`, the interval is empty and every submission is a miss.

Count the total number of reuse hits.

## Input

The first line contains `N K`.

The remaining input contains `N` whitespace-separated fingerprints in chronological order.

## Output

Output one line containing the number of reuse hits.

## Constraints

- `1 <= N <= 200000`
- `0 <= K <= N`
- Every fingerprint has length from `1` to `32`.
- Every character is one of `0`–`9` or `a`–`f`.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
7 3
a b c a d b a
```

Output:

```text
2
```

### Example Two

Input:

```text
4 0
aa aa aa aa
```

Output:

```text
0
```

### Example Three

Input:

```text
5 1
aa aa aa bb aa
```

Output:

```text
2
```

<!-- END GENERATED SAMPLES -->
