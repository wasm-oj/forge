# Exact Dependency Cache

The in-browser compilation cache of a WASM OJ must avoid recompiling every translation unit (TU) whenever one header changes. That conservative policy is safe, but it wastes substantial instruction cost and turns a small source edit into a full rebuild.

Instead, the compiler records exactly which headers each TU actually read during compilation. A TU is a cache miss in a round only if the changed set contains at least one of those headers. If the changed set and its exact dependencies are disjoint, the existing compilation result remains a hit.

To evaluate a series of independent editing scenarios, assume that every miss has finished rebuilding by the end of its round. The next round therefore starts again from a clean baseline rather than inheriting changes from earlier rounds.

Given the fixed TU-to-header dependencies and several changed-header sets, output how many TUs are cache misses in each round.

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
