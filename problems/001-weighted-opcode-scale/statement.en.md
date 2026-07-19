# Weighted Opcode Scale

While designing compute limits for a WASM OJ, we cannot merely count how many instructions a program executes. Different WebAssembly opcodes do different amounts of work; treating them all as equally expensive would place the same unreasonable limit on simple operations and costly ones. We therefore assign weights to opcodes that have been characterized and use a conservative cost for opcodes that have not yet been calibrated individually.

Opcodes are represented by integer IDs from `1` through `K`. Exactly `W` IDs have explicitly specified weights, and every unlisted ID has weight `1000`. Because an execution trace can be long, the measured trace has already compressed consecutive occurrences of the same opcode into `R` runs. Each run records an opcode ID and its consecutive occurrence count.

When tuning the cost budget, we evaluate the same trace under several candidate budgets. Every query is independent: execution restarts at the beginning of the trace, and an instruction may only be executed in full. It is not possible to pay part of its cost and leave a partially completed instruction.

For each budget, output the maximum number of instructions that can be completed in order and the actual total cost of those completed instructions.

## Input

The first line contains `K W R Q`.

The next `W` lines each contain `id weight`. These `id` values are distinct. Every ID not listed has weight `1000`.

The next `R` lines each contain `id count`, describing the execution trace in order.

The final `Q` lines each contain one `budget`.

## Output

For each query, output one line containing `instructions cost`.

`instructions` is the length of the longest trace prefix whose total cost does not exceed `budget`; `cost` is the cost of that prefix. A prefix may stop partway through a run, but every included instruction is charged in full. The empty prefix is valid and has cost `0`.

## Constraints

- `1 ≤ K,R,Q ≤ 200000`
- `0 ≤ W ≤ K`
- `1 ≤ id ≤ K`
- `1 ≤ weight ≤ 10^6`
- `1 ≤ count ≤ 10^12`
- `0 ≤ budget ≤ 9×10^18`
- The total instruction count and total cost of the entire trace are each at most `9×10^18`.
- All integers are decimal. Every multiplication and addition required by the problem fits in an unsigned 64-bit integer.

Under the full constraints, rescanning every run for every query is too slow.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 3 4 5
1 2
2 5
3 20
1 3
5 2
2 4
3 1
0
6
10
2010
2040
```

Output:

```text
0 0
3 6
3 6
5 2006
9 2026
```

### Example Two

Input:

```text
1 0 1 3
1 10
999
1000
9999
```

Output:

```text
0 0
1 1000
9 9000
```

### Example Three

Input:

```text
2 2 3 4
1 7
2 3
1 2
2 3
1 1
13
14
22
30
```

Output:

```text
1 7
2 14
4 20
6 30
```

<!-- END GENERATED SAMPLES -->
