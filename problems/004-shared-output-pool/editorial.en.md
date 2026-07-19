# Editorial

## Intuitive Approach

For every budget, restart at the first event, subtract sizes, and maintain three counters. This is `O(NQ)`. Prefix sums plus a binary search for the first overflowing event improve it to `O(N+Q log N)`.

## Optimal Approach: Monotone Two Pointers

Because budgets are nondecreasing, the number of completely retained events never decreases. Maintain an index `i`, the total `used` by the first `i` complete events, and their three per-stream totals. For budget `B`, repeatedly include the next event while `used+bytes[i]≤B`. Across all queries, each event is included at most once.

If `i=N`, output failure `0`. Otherwise event `i+1` fails; add `B-used` only to that event's stream in the temporary answer. Do not commit this partial amount to the shared state, because the event has not yet been retained in full.

## Correctness Proof

After processing a budget, the loop condition guarantees that the first `i` events all fit completely. If a next event exists, `used+size>B`, so `i+1` is exactly the first failure. The remaining capacity `B-used` is nonnegative and smaller than that event, and the specification retains exactly that many bytes in its stream. Monotone budgets ensure that every event previously included in full remains valid for later queries, so the pointer never needs to move backward. Partial bytes are not committed and therefore cannot contaminate the next query. By induction over queries, every answer is correct.

## Complexity

The event pointer advances at most `N` times in total, and each query does `O(1)` additional work, so total time is `O(N+Q)`. Events precede budgets in the input and must be retained for the later scan, giving `O(N)` core auxiliary space. Including buffered input/output, the common worst-case space bound is `O(N+Q)`. Input and output sizes give an `Ω(N+Q)` time lower bound.

## Common Mistakes

- Treating a write as indivisible and omitting the failed event's retained prefix.
- Reporting an event as failed when the budget lands exactly at its end; the next event must be considered instead.
- Committing the partial retained amount, which makes repeated-budget answers grow.
- Giving each stream a separate budget instead of one shared budget.
