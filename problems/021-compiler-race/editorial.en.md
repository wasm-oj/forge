# Editorial

## Intuitive Approach

Store every job in an array. On `S`, scan all jobs and cancel live background ones; requests may also scan for a matching key. This can perform quadratically many checks and is infeasible for `N=200000`.

## Optimal Approach: Generation Stamps

Use a hash map from each key to its most recently associated job ID. Store every job's key, kind, creation generation, and explicit `alive` flag in arrays. Also maintain current generation `epoch` and the number `liveBg` of live background jobs in it.

A background job is alive exactly when its flag is true and `job.epoch==epoch`; a foreground job only checks the flag. `S` outputs `liveBg`, resets it to zero, and increments `epoch`, cancelling arbitrarily many jobs in `O(1)`. Stale background entries remain in the map lazily; when a later request finds one, the generation check rejects it and the map entry is overwritten.

## Correctness Proof

Induct over events. Initially no jobs exist. A request uses the map to find the only possible most-recent live job for its key; the alive predicate exactly matches the specification, so the algorithm outputs the correct `JOIN` or `NEW`. A `D` uses the same predicate and clears `alive` and the count on success, so a job completes at most once. Before `S`, `liveBg` equals the number of live background jobs in the current generation. Incrementing `epoch` makes all their generation stamps differ simultaneously, while foreground liveness does not depend on the epoch. This is exactly supersede behavior, so every output is correct.

## Complexity

Hash-map operations are expected `O(1)`, so every event is expected `O(1)`, total expected time is `O(N)`, and space is `O(N)`.

## Common Mistakes

- Cancelling foreground jobs on `S`.
- Returning `DONE` for a superseded job.
- Upgrading a background job to foreground on `JOIN`; no such rule exists.
- Clearing a key-map entry without checking that it still points to the completed ID.
