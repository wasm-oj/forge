# Non-Blocking Logical Clock

A deterministic runtime has a logical clock initially equal to `0` and cannot actually wait. Process `N` commands in order:

- `T id deadline`: add a timer with an absolute deadline. Each `id` is added only once in the entire input.
- `C id`: cancel a timer that is currently active.
- `P ready`: perform one poll; `ready` is the current number of ready file-descriptor events.

The poll rules are:

1. If `ready>0`, the clock does not advance.
2. If `ready=0`, no active timer has deadline at most the current clock, and at least one active timer exists, immediately fast-forward the clock to the minimum active deadline.
3. Then fire and remove every active timer with `deadline≤clock`.
4. If `ready=0` and there is no active timer, the clock is unchanged. The clock never moves backward.

## Input

The first line contains `N`, followed by `N` command lines. Every `C` names a timer that is currently active, and there is at least one `P` command.

## Output

For each `P`, output one line:

```text
clock ready fired id1 id2 ...
```

The first three fields are always present. If `fired=0`, the line ends immediately after `fired`. Fired IDs must be ordered increasingly by `(deadline,id)`, comparing both components numerically. This also defines the tie-break for equal deadlines.

## Constraints

- `1 ≤ N ≤ 200000`
- `1 ≤ id ≤ N`
- `0 ≤ deadline ≤ 9×10^18`
- `0 ≤ ready ≤ 10^9`

The full constraints rule out scanning every active timer on every poll.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
8
T 1 5
T 2 3
P 0
P 2
T 3 1
P 1
C 1
P 0
```

Output:

```text
3 0 1 2
3 2 0
3 1 1 3
3 0 0
```

### Example Two

Input:

```text
5
T 3 10
T 1 10
T 2 10
P 0
P 0
```

Output:

```text
10 0 3 1 2 3
10 0 0
```

### Example Three

Input:

```text
9
T 1 8
T 2 4
C 2
P 0
T 4 8
T 3 7
P 5
P 0
P 0
```

Output:

```text
8 0 1 1
8 5 2 3 4
8 0 0
8 0 0
```

<!-- END GENERATED SAMPLES -->
