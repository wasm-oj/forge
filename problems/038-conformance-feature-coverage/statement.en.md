# Best-Value Conformance Suite

While designing a runtime conformance suite for a WASM OJ, we accumulated many candidate tests but could not run all of them before every release. Tests have different instruction costs, and one test may validate several runtime features at once. If multiple tests validate the same feature, that feature still counts as only one covered feature.

Under a limited execution budget, we therefore want to choose the most useful collection of tests so that as many distinct features as possible are actually validated before release.

The runtime has `F` features to validate, numbered `1..F`. Candidate test `i` has execution cost `cost_i` and covers a set of features. A feature is validated if at least one selected test covers it.

Choose any subset of tests with total cost at most budget `B`, maximizing the number of distinct covered features. A test cannot be selected more than once, and the empty subset is valid. Covering a feature repeatedly gives no additional benefit. Output only the maximum coverage count, not the subset.

## Input

The first line contains `F N B`. Each of the next `N` lines has the form:

```text
cost k feature1 ... featurek
```

Feature IDs within one test are distinct. `k = 0` is allowed.

## Output

Output one line containing the maximum number of features that can be covered.

## Constraints

- `1 <= F <= 20`
- `1 <= N <= 25`
- `0 <= B <= 10^12`
- `0 <= cost_i <= 10^9`
- `0 <= k <= F`
- `1 <= feature_j <= F`
- The sum of all costs is at most `2.5 * 10^10` and can be represented exactly.
- Full tests rule out enumerating up to `2^25` test subsets.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
4 3 5
3 2 1 2
2 2 2 3
4 1 4
```

Output:

```text
3
```

### Example Two

Input:

```text
3 3 0
0 1 2
0 2 1 3
1 3 1 2 3
```

Output:

```text
3
```

### Example Three

Input:

```text
5 5 6
2 2 1 2
2 2 1 2
3 2 3 4
3 1 5
7 5 1 2 3 4 5
```

Output:

```text
4
```

<!-- END GENERATED SAMPLES -->
