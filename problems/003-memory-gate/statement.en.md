# 64 KiB Memory Gate

A module declares one or more linear memories indexed from `1` through `N`. Every page is exactly `65536` bytes. Judge policy allows at most `C` pages per memory and does not support Memory64.

Each declaration is `kind initial maximum`, where `kind` is `32` or `64`. `maximum=-1` means that no maximum was declared; otherwise it is the declared page count. A declaration is invalid if any of the following holds:

1. `kind=64`;
2. a maximum is present and `maximum < initial`;
3. `initial > C`.

For a valid declaration, its rewritten maximum is `C` when no maximum was declared, and `min(maximum,C)` otherwise.

Each query gives an interval `[l,r]`. If it contains an invalid declaration, output `REJECT i`, where `i` must be the smallest invalid index in the interval. Otherwise output `ACCEPT initialBytes maximumBytes`, the interval sums of initial and rewritten-maximum page counts, respectively, each multiplied by `65536`.

## Input

The first line contains `N Q C`. The next `N` lines contain the declarations. The final `Q` lines each contain `l r`.

## Output

Output one line per query according to the rules above. Queries are independent, indices are 1-based, and `l≤r`.

## Constraints

- `1 ≤ N,Q ≤ 200000`
- `1 ≤ C ≤ 10^12`
- `kind ∈ {32,64}`
- `0 ≤ initial ≤ 10^12`
- `maximum=-1` or `0 ≤ maximum ≤ 10^12`
- Across all valid declarations, the sum of rewritten maximum page counts is at most `137329101562500`; consequently every output byte count is at most `9×10^18`.

The full constraints rule out scanning an entire interval for each query.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 5 10
32 2 -1
32 4 8
64 1 2
32 11 -1
32 3 2
1 2
2 2
1 3
3 5
4 5
```

Output:

```text
ACCEPT 393216 1179648
ACCEPT 262144 524288
REJECT 3
REJECT 3
REJECT 4
```

### Example Two

Input:

```text
3 3 5
32 0 0
32 5 -1
32 2 100
1 1
1 3
2 3
```

Output:

```text
ACCEPT 0 0
ACCEPT 458752 655360
ACCEPT 458752 655360
```

### Example Three

Input:

```text
4 4 7
32 3 3
32 6 5
32 8 20
64 0 -1
1 1
1 2
2 4
3 4
```

Output:

```text
ACCEPT 196608 196608
REJECT 2
REJECT 2
REJECT 3
```

<!-- END GENERATED SAMPLES -->
