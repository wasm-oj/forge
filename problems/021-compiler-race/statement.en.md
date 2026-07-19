# Compiler Job Generation Race

Automatic checks, manual runs, and interface updates may trigger several in-browser compilation jobs for the same WASM OJ source in quick succession. Creating another compilation when identical input is already being processed wastes instruction cost and can allow an older result to overwrite newer state.

The coordinator therefore coalesces live jobs with the same key and uses generations to distinguish background requests for different versions. When new state supersedes old state, an `S` event cancels every background job still alive in the current generation. Foreground jobs remain alive until they complete successfully. Events are already ordered by when they actually occurred, so there are no undefined thread interleavings.

Job IDs start at 1 and increase only when a job is created. The current generation starts at 0. Process these events:

- `B key`: request a background job.
- `F key`: request a foreground job.
- `S`: cancel every background job that is still alive in the current generation, then increment the generation. Foreground jobs are unaffected.
- `D id`: attempt to complete job `id`.

On `B` or `F`, if that key already has a live job, coalesce the request into that existing job regardless of the new request's kind. Otherwise create a background or foreground job according to the event. A background job is alive only in its creation generation; a foreground job remains alive until it completes successfully. Jobs cancelled by `S` never revive. A key is a nonempty lowercase English string.

## Input

The first line contains event count `N`. Each of the next `N` lines contains one event.

## Output

Output one line for each event:

- New job: `NEW id`
- Coalesced job: `JOIN id`
- `S`: `CANCEL k`, where `k` is the number of jobs actually cancelled by this event
- Successful completion: `DONE`
- Completion of a nonexistent, completed, or cancelled job: `STALE`

## Constraints

- `1 ≤ N ≤ 200000`
- `1 ≤ |key| ≤ 20`
- The total length of all keys is at most `2000000`.
- `1 ≤ id ≤ N+1`
- `D` may name a nonexistent, already completed, or cancelled job.

The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
8
B a
B a
F x
S
D 1
B a
D 2
D 3
```

Output:

```text
NEW 1
JOIN 1
NEW 2
CANCEL 1
STALE
NEW 3
DONE
DONE
```

### Example Two

Input:

```text
5
S
F a
S
F a
D 1
```

Output:

```text
CANCEL 0
NEW 1
CANCEL 0
JOIN 1
DONE
```

### Example Three

Input:

```text
7
B a
B b
D 1
S
D 2
B b
D 3
```

Output:

```text
NEW 1
NEW 2
DONE
CANCEL 1
STALE
NEW 3
DONE
```

<!-- END GENERATED SAMPLES -->
