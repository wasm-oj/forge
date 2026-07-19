# Submission Conveyor

The judge executes at most one submission at a time. All others wait in insertion order. Events are given in a deterministic total order.

- `A id`: add a submission whose ID has never appeared before. If there is no active submission, it becomes active immediately; otherwise it joins the back of the queue.
- `C id`: cancel that ID. If it is waiting or active, it becomes terminal; otherwise do nothing. If the active submission is cancelled, immediately start the earliest-added submission that is still waiting.
- `E`: the active submission finishes normally and becomes terminal; do nothing if no submission is active. Then likewise start the earliest waiting submission.

Cancelling a waiting submission does not change the relative order of the others.

## Input

The first line contains `N`, followed by `N` event lines.

## Output

After every event, output `active waiting`. Output `0` when there is no active submission. `waiting` is the number of still-valid waiting submissions and does not include the active submission.

## Constraints

- `1 ≤ N ≤ 200000`
- `1 ≤ id ≤ 10^9`
- IDs in `A id` events are all distinct.
- `C` may name an ID that has not been added or is already terminal.
- The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
7
A 10
A 20
A 30
C 20
E
C 10
E
```

Output:

```text
10 0
10 1
10 2
10 1
30 0
30 0
0 0
```

### Example Two

Input:

```text
6
A 1
C 1
E
A 2
A 3
C 2
```

Output:

```text
1 0
0 0
0 0
2 0
2 1
3 0
```

### Example Three

Input:

```text
6
A 5
A 6
C 6
A 7
C 5
E
```

Output:

```text
5 0
5 1
5 0
5 1
7 0
0 0
```

<!-- END GENERATED SAMPLES -->
