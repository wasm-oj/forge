# Eight-Stage Compiler

Starting a toolchain for every in-browser build would impose unnecessary cost on a WASM OJ, so we want to reuse workers. A worker cannot accept jobs forever, however, because accumulated state and resource usage would become difficult to control. The coordinator therefore manages workers in generations and gives each generation a lifetime budget.

A supported build contains at most eight output-ready stages. Every stage completed successfully consumes one unit of budget. A generation may consume at most `B` units and may serve only one toolchain family. Assign builds in arrival order according to these rules:

- `stages=0` is a complete cache hit. Output `CACHE`; do not create, switch, or consume the current worker.
- If `stages>8` or `stages>B`, output `REJECT`. A rejection does not change the current worker.
- Every other build must use the **current** generation. If none exists, the family differs, or remaining budget is insufficient, create the next generation and assign the build to it.

Generation IDs start at 1 and increase consecutively. The coordinator keeps only one active worker, so once it leaves an old generation, that generation is never reused even if it still has budget remaining.

## Input

The first line contains `N B`. Each of the next `N` lines contains `family stages`.

## Output

For every build, output one line containing `CACHE`, `REJECT`, or `WORKER g`. Finally output:

```text
SUMMARY workerCount rejectedCount
```

A cache hit counts as neither a worker nor a rejection.

## Constraints

- `1 ≤ N ≤ 300000`
- `1 ≤ B ≤ 9×10^18`
- `0 ≤ stages ≤ 12`
- A family has length `1..20` and contains only lowercase letters, digits, and `-`.
- All counters fit in unsigned 64-bit integers; JavaScript and TypeScript must handle `B` above the safe-integer range correctly.

The full constraints rule out replaying all previous assignments before every build to reconstruct the current generation.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
6 5
a 3
a 2
a 1
b 0
b 4
b 2
```

Output:

```text
WORKER 1
WORKER 1
WORKER 2
CACHE
WORKER 3
WORKER 4
SUMMARY 4 0
```

### Example Two

Input:

```text
4 4
x 5
y 9
x 0
x 4
```

Output:

```text
REJECT
REJECT
CACHE
WORKER 1
SUMMARY 1 2
```

### Example Three

Input:

```text
5 8
a 4
b 0
a 4
b 1
a 1
```

Output:

```text
WORKER 1
CACHE
WORKER 1
WORKER 2
WORKER 3
SUMMARY 3 0
```

<!-- END GENERATED SAMPLES -->
