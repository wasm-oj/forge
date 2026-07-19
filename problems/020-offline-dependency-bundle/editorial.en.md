# Editorial

## Intuitive Approach

For every package, search all payloads linearly, then scan required records for every payload. This takes `O(NM)` time and makes duplicates and category priority easy to mishandle.

## Optimal Approach: Sort and Compare Digest Groups

Sort lock records and payload records separately by digest. Equal digests become contiguous: a lock group can be checked for inconsistent sizes and compressed into one required record, while a payload group can be checked for duplicates.

Finish checking an entire error category before proceeding to the next. First find the smallest lock conflict, then the smallest payload duplicate. Afterward, binary search or two pointers can find the smallest missing digest, extra digest, and size mismatch in order. If no error exists, the package-size total and unique-required total accumulated during processing yield the requested statistics.

## Correctness Proof

Sorting makes all records of one digest adjacent, so a group comparison detects exactly whether that digest has a lock conflict or duplicate payload. The first such group is the lexicographically smallest digest in its category. After compression, required and payload records are sorted sets. Membership comparison detects missing and extra digests exactly; once the sets match, comparing sizes at equal keys detects exactly `SIZE`. The algorithm examines a later category only after proving the earlier category empty, so error priority is correct. With no error, every required digest has exactly one equal-sized payload, and the difference between package total and unique-digest total is precisely the bytes saved by deduplication.

## Complexity

Sorting takes `O((N+M) log(N+M))`; subsequent scans or searches stay within that bound. Space is `O(N+M)`. In the comparison model, canonical ordering of arbitrary digest tokens requires this asymptotic scale.

## Common Mistakes

- Reporting a missing digest immediately and overlooking a higher-priority duplicate payload.
- Counting the same digest repeatedly in `deduplicatedBytes`.
- Comparing sets by package name rather than digest.
- Accumulating into a 32-bit temporary before converting to 64 bits.
