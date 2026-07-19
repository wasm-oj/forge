# Bidirectional Interactive Pipes

An interactive problem requires a WASM OJ to drive the participant program and the interactor together. They exchange data through capacity-limited pipes. Unless blocking, closure, and scheduling order are modeled precisely, different hosts could produce different deadlock or failure verdicts for the same interaction.

Call the two processes A and B. They communicate through `A→B` and `B→A`, two pipes that each have capacity `C`. Each process has a sequence of actions:

- `W k`: atomically write to the outgoing pipe. The action completes only when at least `k` capacity remains; otherwise it blocks.
- `R k`: atomically read from the incoming pipe. The action completes only when at least `k` bytes are present. If fewer bytes are present and the incoming pipe is closed, it immediately fails; otherwise it blocks.
- `C`: close this process's outgoing pipe and complete. Each process has at most one `C`, and no `W` follows it.

When a process finishes its final action, its outgoing pipe also closes automatically. Actions depend only on byte counts; byte contents are irrelevant.

### Deterministic Scheduler

To make the simulation reproducible, the scheduler uses fixed rounds: attempt A's next action once, then B's next action once. Skip a process that is already finished. A blocked attempt changes no state, but the other process is still attempted. If a read definitely produces `FAILURE`, stop immediately and do not attempt the other process in that round.

If both processes finish, the result is `SUCCESS`. If one complete round finishes no action and causes no `FAILURE`, the result is `DEADLOCK`. Both pipes are initially empty. A process with an empty action sequence is already finished initially and has its outgoing pipe closed.

## Input

The first line contains `C NA NB`, followed by `NA` actions for A and `NB` actions for B.

## Output

Output exactly one of:

- `SUCCESS steps ab ba`
- `DEADLOCK steps ab ba`
- `FAIL A steps ab ba`
- `FAIL B steps ab ba`

`steps` is the number of actions completed before stopping. `ab` and `ba` are the final occupancies of the two pipes.

## Constraints

- `1 ≤ C ≤ 10^18`
- `0 ≤ NA,NB ≤ 200000`
- `1 ≤ NA+NB ≤ 200000`
- `1 ≤ k ≤ C`
- The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 3 3
W 3
R 2
C
R 3
W 2
C
```

Output:

```text
SUCCESS 6 0 0
```

### Example Two

Input:

```text
3 2 2
R 1
C
R 1
C
```

Output:

```text
DEADLOCK 0 0 0
```

### Example Three

Input:

```text
4 2 1
C
R 1
C
```

Output:

```text
FAIL A 2 0 0
```

<!-- END GENERATED SAMPLES -->
