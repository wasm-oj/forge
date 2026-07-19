# Empty-Program Baseline Calibration

When measuring instruction cost in a WASM OJ, the compiler and execution environment introduce fixed overhead of their own. Charging this overhead directly to the submitted program would make compilation profiles difficult to compare fairly. We therefore run an empty program first and establish a deductible baseline for each profile.

A baseline may be published only when its measurements are complete and reproducible. The system observes `P` compilation profiles, and each profile is expected to have exactly one result for every seed from `1` through `S`. A profile has a publishable baseline only if every seed is present and all observed costs are identical.

Measurements may arrive in any order, but the same `(profile, seed)` pair appears at most once in the input. Each later query supplies a profile and a raw cost so that the submitted program's cost can be computed after removing the environmental baseline.

If the profile has no publishable baseline, output `INVALID`. Otherwise, output the baseline and the net cost. Net cost may not be negative, so it is defined as `max(0, raw-baseline)`.

## Input

The first line contains `P S N Q`. The next `N` lines contain `profile seed cost`. The final `Q` lines contain `profile raw`.

## Output

Output one line per query. For a valid profile, output `baseline net`. For an invalid profile, output only `INVALID`. Queries do not modify the calibration data.

## Constraints

- `1 ≤ P,S,Q ≤ 200000`
- `0 ≤ N ≤ 200000`
- `1 ≤ profile ≤ P`, `1 ≤ seed ≤ S`
- All `(profile,seed)` pairs are distinct.
- `0 ≤ cost,raw ≤ 9×10^18`

Given the seed range and uniqueness guarantees above, `count=S` is equivalent to saying that the profile has no missing seed. The full constraints rule out rescanning all observations for every query.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 2 5 5
1 1 10
2 2 8
3 2 4
1 2 10
2 1 7
1 6
1 15
2 99
3 4
1 10
```

Output:

```text
10 0
10 5
INVALID
INVALID
10 0
```

### Example Two

Input:

```text
4 1 3 4
3 1 9
1 1 0
4 1 20
1 5
2 5
3 8
4 25
```

Output:

```text
0 5
INVALID
9 0
20 5
```

### Example Three

Input:

```text
2 3 6 3
2 3 5
1 2 0
2 1 5
1 1 0
2 2 5
1 3 0
1 0
1 12
2 4
```

Output:

```text
0 0
0 12
5 0
```

<!-- END GENERATED SAMPLES -->
