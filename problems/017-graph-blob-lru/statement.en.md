# Graph Blob LRU

Several build-graph nodes may reference the same output digest; the cache pays for that blob only once. When capacity is insufficient, blobs are evicted in LRU order, immediately invalidating every node that references the evicted digest.

There are `N` nodes and `D` digests. Process these operations:

- `P u d`: node `u` publishes digest `d`. First remove `u`'s old reference. If `size[d] > C`, no new reference is created and the LRU order is unchanged. Otherwise load the blob (without charging it again if it is already cached), attach `u` to it, and move it to MRU. While over capacity, repeatedly evict the LRU blob.
- `G u`: if `u`'s reference is still valid, output `HIT d` and move that blob to MRU; otherwise output `MISS`.

A cached blob with no node references remains in the cache and participates in LRU until evicted. Repeating `P` with the same `(u,d)` still applies the complete rule: detach first, then attach and touch.

## Input

The first line contains `N D Q C`. The second line contains the `D` blob sizes. Each of the next `Q` lines is `P u d` or `G u`. All IDs are 1-based. Initially, no blob is cached and no node has a reference.

## Output

For each `G`, output one line containing `HIT d` or `MISS`. Output nothing for `P` operations.

## Constraints

- `1 ≤ N,D,Q ≤ 200000`
- There is at least one `G` operation.
- `0 ≤ C,size[d] ≤ 9×10^18`
- The sum of all blob sizes is at most `9×10^18`.
- Cache occupancy always fits in an unsigned 64-bit integer.
- If one eviction invalidates many nodes, all those references came from earlier `P` operations; full-credit solutions must exploit this amortized property.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 3 7 5
3 2 4
P 1 1
P 2 2
G 1
P 3 3
G 2
G 3
G 1
```

Output:

```text
HIT 1
MISS
HIT 3
MISS
```

### Example Two

Input:

```text
3 1 5 2
2
P 1 1
P 2 1
G 1
P 1 1
G 2
```

Output:

```text
HIT 1
HIT 1
```

### Example Three

Input:

```text
1 2 6 3
4 3
P 1 1
G 1
P 1 2
G 1
P 1 1
G 1
```

Output:

```text
MISS
HIT 2
MISS
```

<!-- END GENERATED SAMPLES -->
