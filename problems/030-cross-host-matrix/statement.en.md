# Cross-Host Consistency Matrix

The first host is the baseline. Every host records an **ordered** sequence of cases. Each case has an ID, a runtime, and transcript fields whose dotted paths are strictly increasing. Runtime is not part of the deterministic transcript.

For each non-baseline host, in input order:

1. If its case-ID sequence, including its length, is not identical to the baseline sequence, output `HOST name CASE_ORDER` and do not compare fields for that host.
2. Otherwise, find every dotted path that differs in each corresponding case. A path differs if it occurs on only one side or if its values differ. Report differences in baseline case order and then ASCII lexicographic path order.
3. If there are no differences, output `HOST name OK`. Otherwise output `HOST name k p1 ... pk`, writing each path as `caseId.fieldPath`.

If every non-baseline host is `OK`, also output the lower median runtime for every baseline case. Sort all `H` runtimes and choose index `floor((H - 1) / 2)`, then output `MEDIAN caseId value`. If any host is inconsistent, output no median lines.

## Input

The first line contains `H`. Each host begins with `name K`, followed by `K` cases. A case header is `caseId runtime P`, followed by `P` lines of `path value`.

## Output

Output one line for every non-baseline host in input order. If and only if they are all `OK`, follow those lines with one median line per baseline case in baseline order.

## Constraints

- `2 <= H <= 200`
- Host names are globally unique; case IDs are unique within a host.
- Paths within each case are strictly increasing.
- `name`, `caseId`, and `value` contain `1..20` lowercase letters or digits.
- `path` has length `1..120` and consists of dot-separated lowercase alphanumeric segments.
- `0 <= runtime <= 10^18`
- The sum of all `K` values is at most `200000`.
- The sum of all `P` values is at most `200000`.
- Let `D` be the total number of differing paths actually printed for non-baseline hosts whose case-ID sequences are correct. Hosts reported as `CASE_ORDER` do not contribute to `D`; `D <= 200000`.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3
h0 2
c1 10 2
a 1
b 2
c2 30 1
x 9
h1 2
c1 20 2
a 1
b 2
c2 40 1
x 9
h2 2
c1 50 2
a 1
b 3
c2 60 1
x 9
```

Output:

```text
HOST h1 OK
HOST h2 1 c1.b
```

### Example Two

Input:

```text
2
a 1
x 8 1
ok yes
b 1
x 2 1
ok yes
```

Output:

```text
HOST b OK
MEDIAN x 2
```

### Example Three

Input:

```text
2
a 2
x 1 0
y 2 0
b 2
y 3 0
x 4 0
```

Output:

```text
HOST b CASE_ORDER
```

<!-- END GENERATED SAMPLES -->
