# Editorial

## Intuitive Approach

Materialize each pipe as a byte queue of capacity `C` and push or pop `k` times per action. Total byte activity `B` may vastly exceed input size, while `C` can reach `10^18`, making `O(B)` time and `O(C)` space impossible.

## Optimal Approach: Occupancy-Only Event Simulation

Maintain only occupancies `ab` and `ba`, two program counters, and the outgoing-closed flags. Whether `W` or `R` can execute depends only on occupancy and `C`; on success, add or subtract `k` directly. In every round, call `tryStep` once for A and once for B in fixed order and track whether any action progressed. When a read lacks bytes and the peer's outgoing pipe is closed, report failure. Set a pipe closed when its program counter reaches the end.

## Correctness Proof

Induct over action attempts. Each occupancy equals the byte count in its actual pipe: a successful write adds `k`, a successful read subtracts `k`, and every other attempt leaves it unchanged. Since byte contents never affect any condition, these counters are indistinguishable from real queues for all future actions. Each closed flag is set exactly by `C` or natural process completion. Therefore `tryStep` classifies success, blocking, and failure exactly as specified. Calling it in the prescribed A-then-B order yields the correct final state and result.

## Complexity

Every successful action executes exactly once. Every progressing round completes at least one action, followed by at most one no-progress round. Time is `O(NA+NB)`, and storing all actions uses `O(NA+NB)` space.

## Common Mistakes

- Allowing `W` or `R` to complete partially.
- Skipping B after A blocks.
- Forgetting to close a pipe when its process ends naturally.
- Executing the other process after a failure in the same round.
