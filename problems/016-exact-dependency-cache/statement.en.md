# Exact Dependency Cache

The compiler records exactly which headers each translation unit (TU) actually read. In a round, a TU is a cache miss if the changed set contains at least one header it read; otherwise it is a hit. Every miss has been rebuilt by the end of that round, so the next round starts again from a clean baseline.

Given fixed exact dependencies and several rounds of changed-header sets, output the number of cache-miss TUs in each round.

## Input

The first line contains `N H M Q`: the number of TUs, headers, dependency edges, and rounds. The next `M` lines contain `s h`, meaning TU `s` read header `h`. Each of the next `Q` lines contains `K h_1 ... h_K`.

TU IDs and header IDs are each 1-based. Header IDs within a round are distinct. When `K=0`, the line contains only `0`.

## Output

Output `Q` lines. Line `i` contains one decimal integer: the number of TUs depending on at least one header changed in round `i`. Output `0` when no TU misses.

## Constraints

- `1 ≤ N,H ≤ 6000`
- `0 ≤ M ≤ 200000`
- `1 ≤ Q ≤ 20000`
- Dependency edges are distinct.
- The sum of `K` over all queries is at most `50000`.
- A machine word in the word-RAM model has at least 32 bits.
- Tests repeatedly change high-degree headers; worst-case scalar marking through reverse adjacency lists does not pass.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 3 4 2
1 1
2 1
2 2
3 2
2 1 2
1 3
```

Output:

```text
3
0
```

### Example Two

Input:

```text
2 2 2 2
1 1
2 2
0
1 2
```

Output:

```text
0
1
```

### Example Three

Input:

```text
3 1 3 3
1 1
2 1
3 1
1 1
1 1
0
```

Output:

```text
3
3
0
```

<!-- END GENERATED SAMPLES -->
