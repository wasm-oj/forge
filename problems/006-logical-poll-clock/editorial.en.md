# Editorial

## Intuitive Approach

Keep a table of active timers. On every poll, scan the table once to find the minimum deadline and again to collect expired timers. Interleaved insertions and polls can make this `O(N^2)`.

## Optimal Approach: Min-Heap with Lazy Cancellation

Put `(deadline,id)` into a min-heap and track validity separately with `active[id]`. Cancellation only sets the flag to false; a stale heap entry is discarded when it reaches the top.

For a poll, first remove cancelled entries from the heap top. If `ready=0` and the heap is nonempty, set `clock=max(clock,minDeadline)`. Then repeatedly pop entries with `deadline≤clock`: ignore cancelled entries, and output and deactivate active ones. Because the heap key is exactly `(deadline,id)`, the pop order is the required output order.

## Correctness Proof

After entries with `active=false` are ignored, the heap retains the original key of every active timer, so after top cleanup its top is the minimum active `(deadline,id)`. With no ready event, if that deadline lies in the future, advancing to it matches the rule; if it is already due, `max` preserves the clock. The loop removes all and only active timers whose deadlines do not exceed the clock, and heap order emits them increasingly by `(deadline,id)`. Cancelled timers are never output. Therefore every poll has the correct clock, fired set, and order, and removed timers never fire again.

## Complexity

Every timer enters and leaves the heap at most once, each in `O(log N)` time. All other command work is `O(1)`, so total time is `O(N log N)` and space is `O(N)`.

## Common Mistakes

- Advancing the clock even when at least one fd event is ready.
- Searching linearly through the heap on cancellation, causing quadratic time.
- Moving the clock backward when a newly added deadline is earlier than the current clock; it should fire on the next poll without rewinding time.
- Ordering only by deadline and omitting the ID tie-break.
