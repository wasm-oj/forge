# Eight-Stage Compiler

Browser compiler workers are used in generations. Every successfully completed output-ready stage consumes one unit of lifetime budget. One generation has at most `B` units and can serve only one toolchain family. Assign builds in arrival order:

- `stages=0` is a complete cache hit. Output `CACHE`; do not create, switch, or consume the current worker.
- If `stages>8` or `stages>B`, output `REJECT`. A rejection does not change the current worker.
- Every other build must use the **current** generation. If none exists, the family differs, or remaining budget is insufficient, create the next generation and assign the build to it.

Generation IDs start at 1 and increase consecutively. Once the coordinator leaves an old generation, it is never reused, even if it has remaining budget; the coordinator has only one active worker.

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
