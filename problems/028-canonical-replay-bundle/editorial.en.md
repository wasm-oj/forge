# Editorial

## Intuitive Approach

Check the three local conditions first, then scan all blobs from the beginning for every reference. This preserves the required error-phase order, but the repeated searches take `O(BR)` time in the worst case.

## Optimal Approach: Canonical Merge

Check the phases in their prescribed order and stop immediately when a phase fails:

1. scan adjacent blob digests for the first non-increasing position;
2. scan blob records for the first length mismatch;
3. scan adjacent reference digests for the first non-increasing position.

After these checks, both digest sequences are strictly sorted. Use two pointers to verify references against blobs. If the blob digest is smaller, advance the blob pointer. If the digests match, advance both pointers. If the blob digest is larger, or the blobs are exhausted, the current 1-indexed reference is the first missing one.

Perform this verification merge without summing lengths. Only after every reference is known to exist, run a second merge and add the actual length at each match. This matters because the bound on `total` is guaranteed only for valid bundles; an invalid bundle could otherwise overflow a 64-bit accumulator before its missing reference is discovered.

## Correctness Proof

Each of the first three scans examines records from left to right, so it reports the smallest invalid position in its phase. A later phase is entered only after every earlier phase passes, hence the mandated phase priority is respected.

During a merge, a blob digest smaller than the current reference cannot match that reference or any earlier one, so discarding it is safe. Equal digests give the unique match because both sequences are strictly increasing. If the next blob is larger than the reference, every later blob is larger as well, so that reference is missing. Thus the first merge accepts exactly when every reference exists and reports the smallest missing reference otherwise.

Once the first merge succeeds, the bundle satisfies all four conditions. The second merge visits the unique blob matching each reference and no unreferenced blob, so its sum is exactly the required `total`. Therefore the algorithm always produces the specified output.

## Complexity

Every pointer advances at most once per merge. The total running time is `O(B + R)`, and storing the input uses `O(B + R)` space. A streaming implementation can reduce the auxiliary storage to `O(B)`.

## Common Mistakes

- Reporting a length mismatch before a higher-priority blob-order error.
- Checking only that adjacent digests differ and accidentally accepting descending order.
- Reporting a blob position for `MISSING` instead of the reference position.
- Including unreferenced blobs in `total`.
- Accumulating before missing references have been ruled out, which can overflow on invalid input.
