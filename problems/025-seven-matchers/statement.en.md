# Seven Answer Matchers

Answer validation in a WASM OJ cannot assume that “correct” always means two outputs are byte-for-byte identical. Some problems care about one complete string, some ignore set order, some preserve multiplicity, and others compare numeric tolerance or a collection of output files.

The system therefore provides seven matchers so that every problem can select its exact judging semantics. Each query contains expected and actual token arrays and chooses one matcher. `n` and `m` may be zero; the corresponding data line is then empty.

- `EXACT`: concatenate all tokens on each side **without separators**, then compare the two strings.
- `LINES`: token `#` represents an empty line. Remove all trailing `#` tokens from each array, then compare item by item.
- `TOKENS`: compare tokens item by item for exact equality.
- `FLOAT`: the arrays must have equal lengths. Tokens are signed integers, and the absolute difference of every pair must be at most the `eps` on the header line.
- `SET`: ignore order and multiplicity; compare the sets of distinct tokens.
- `MULTISET`: ignore order but preserve multiplicity.
- `FILESET`: every token has form `path@digest`. `path` is a lowercase alphanumeric string of length `1..20`, and `digest` is exactly eight lowercase hexadecimal characters, so a complete entry has length `10..29` bytes. Paths are unique on each side. Ignore file order; complete entries must match.

Except for the additional `FLOAT` and `FILESET` restrictions, an ordinary token is an ASCII string of length `1..30` over `[A-Za-z0-9_#@.-]`. Every comparison is byte-exact and locale-independent.

## Input

The first line contains the number of queries `Q`. Each query occupies three lines: a header `type n m` (or `FLOAT n m eps`), an expected-token line, and an actual-token line.

## Output

For each query, output `ACCEPT` or `WRONG`.

## Constraints

- `1 ≤ Q ≤ 20000`
- The sum of `n+m` over all queries is at most `200000`.
- Total token length is at most `4000000`.
- `FLOAT` values lie in `[-10^18,10^18]` and `0≤eps≤10^18`.
- A `FILESET` path has length `1..20` and contains only lowercase alphanumeric characters.
- A `FILESET` digest has exactly eight lowercase hexadecimal characters; a complete entry has length `10..29` bytes.
- The full constraints apply to every official test.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
7
EXACT 2 2
ab c
a bc
LINES 3 1
x # #
x
TOKENS 2 2
a b
b a
FLOAT 3 3 2
10 -5 7
12 -6 4
SET 3 2
a a b
b a
MULTISET 3 2
a a b
a b
FILESET 2 2
a@00000001 b@00000002
b@00000002 a@00000001
```

Output:

```text
ACCEPT
ACCEPT
WRONG
WRONG
ACCEPT
WRONG
ACCEPT
```

### Example Two

Input:

```text
3
EXACT 0 0


LINES 2 3
# #
# # #
FLOAT 2 2 0
-1 0
-1 0
```

Output:

```text
ACCEPT
ACCEPT
ACCEPT
```

### Example Three

Input:

```text
3
SET 0 1

x
MULTISET 3 3
z z a
z a z
FILESET 1 1
x@deadbeef
x@deadc0de
```

Output:

```text
WRONG
ACCEPT
WRONG
```

<!-- END GENERATED SAMPLES -->
