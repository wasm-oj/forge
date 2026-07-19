# Editorial

## Intuitive Approach

Represent the true waiting queue with an array. Cancelling searches and removes an element, while starting the next submission shifts all remaining elements from the front. Interleaved additions and cancellations can cost `O(N^2)`.

## Optimal Approach: Queue with Lazy Deletion

Each ID has one of four states: nonexistent, `queued`, `active`, or `terminal`. Append every added waiting ID to a deque. To cancel a waiting submission, only change its state to terminal in the hash map; do not remove it from the middle. When a submission must start, repeatedly discard non-queued IDs from the front, then change the first queued ID to active. Every ID is enqueued and dequeued at most once.

Maintain a separate `waiting` counter: increment it when adding to a system with an active submission, decrement it when cancelling a queued submission, and also decrement it when a queued submission becomes active.

## Correctness Proof

The deque preserves insertion order for every ID not yet examined at the front. Elements whose state is `queued` are exactly the valid waiters; terminal elements are tombstones that may be skipped safely. Thus after skipping tombstones, the first queued element is exactly the earliest valid waiting submission required by the specification. Each event performs only its specified state transition and invokes the start routine whenever the active submission disappears. By induction, both reported active ID and waiting count are correct after every event.

## Complexity

Hash operations are expected `O(1)`. Across all events, deque removals total `O(N)`, so total expected time is `O(N)` and space is `O(N)`.

## Common Mistakes

- Including the active submission in `waiting`.
- Forgetting to decrement the counter when cancelling a queued submission.
- Removing cancelled IDs from the middle of the deque and causing quadratic time.
- Starting a job or reporting an error when `E` occurs on an empty system.
