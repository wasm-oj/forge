# Editorial

## Intuitive Approach

Store LRU order in an array, linearly searching and moving entries on every touch. On eviction, scan all `N` nodes for references. This costs `O(Q(N+D))` in the worst case.

## Optimal Approach: Two Intrusive Doubly Linked Structures

Digest IDs are dense, so arrays can store `cached` and LRU `prev/next` links. A doubly linked list from `head=LRU` to `tail=MRU` implements touch, insertion, and removal in constant time.

Each node references at most one digest. For every digest, maintain another doubly linked list of referencing nodes. Per-node `refPrev/refNext` links allow `O(1)` detachment during reassignment. When a digest is evicted, walk its reference list and clear every node mapping.

One eviction may visit many nodes, but every visited reference was created by an earlier `P` attachment. Once invalidated, it cannot be visited again unless another `P` recreates it. Therefore total reference visits over all evictions are at most `Q`.

## Correctness Proof

Maintain three invariants: (1) every cached digest appears exactly once in LRU order, ordered by its most recent successful `P` or hit `G`; (2) node mappings and digest reverse lists agree; and (3) occupancy is the sum of distinct cached blob sizes. Detach, attach, and touch operations preserve their corresponding invariants. Eviction removes the head, exactly the required least-recently-used blob; clearing its complete reverse list invalidates all and only references to that digest, while subtracting its size once preserves occupancy. Repeating stops exactly when occupancy is at most `C`. The oversize branch performs only the required detachment. By induction, all invariants hold after every operation, so each `G` result, digest, and recency update is correct.

## Complexity

Every operation except reference invalidation is `O(1)`. Each attached reference is invalidated at most once before another attachment, so total time is `O(Q)` amortized and space is `O(N+D)`.

## Common Mistakes

- Using nodes rather than blobs as the LRU unit, breaking digest deduplication.
- Failing to detach a reassigned node from the old digest's reverse list.
- Removing an unreferenced blob immediately; it must remain cached.
- Forgetting to clear the old reference before an oversize `P`.
