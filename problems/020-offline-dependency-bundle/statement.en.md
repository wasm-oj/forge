# Offline Dependency Suitcase

Several lockfile packages may refer to the same content digest. An offline bundle must provide exactly one payload for every **unique required digest**: none may be missing or extra, and every size must match. If packages declare different sizes for the same digest, the lockfile contradicts itself.

## Input

The first line contains `N M`. The next `N` lines contain:

```text
packageName digest declaredSize
```

The following `M` lines contain:

```text
digest payloadSize
```

Package names are unique. Digests are precomputed lowercase hexadecimal tokens and are treated as collision-free.

## Output

Output only the first applicable category below. When several digests belong to that category, choose the ASCII-lexicographically smallest one:

1. `LOCK_CONFLICT digest`: the same required digest has different declared sizes.
2. `DUPLICATE_PAYLOAD digest`: the bundle contains the same digest more than once.
3. `MISSING digest`: a required digest has no payload.
4. `EXTRA digest`: a payload digest is not required.
5. `SIZE digest`: required size and payload size differ.

If every check passes, output:

```text
VALID uniqueDigestCount deduplicatedBytes savedBytes
```

`deduplicatedBytes` is the sum of sizes over unique digests. `savedBytes` is the sum of every package's declared size minus `deduplicatedBytes`. A zero-size digest still counts as one digest.

## Constraints

- `1 ≤ N,M ≤ 200000`
- `packageName` matches `[a-z0-9-]{1,30}` and package names are distinct.
- A digest matches `[0-9a-f]{8,64}`.
- Each size lies from 0 through `9×10^18`.
- The sum of all package declared sizes is at most `9×10^18`.

The full constraints rule out pairwise linear searches between required and payload records.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 2
a aaaaaaaa 5
b bbbbbbbb 7
c aaaaaaaa 5
aaaaaaaa 5
bbbbbbbb 7
```

Output:

```text
VALID 2 12 5
```

### Example Two

Input:

```text
2 1
a aaaaaaaa 5
b aaaaaaaa 6
aaaaaaaa 5
```

Output:

```text
LOCK_CONFLICT aaaaaaaa
```

### Example Three

Input:

```text
1 2
a aaaaaaaa 5
aaaaaaaa 5
aaaaaaaa 5
```

Output:

```text
DUPLICATE_PAYLOAD aaaaaaaa
```

<!-- END GENERATED SAMPLES -->
