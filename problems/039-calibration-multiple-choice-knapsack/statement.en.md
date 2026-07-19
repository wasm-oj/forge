# Calibration Experiment Scheduling

While designing instruction-cost calibration for a WASM OJ, we needed to measure different language and toolchain profiles regularly. For one profile, we might run a fast plan that provides limited evidence or spend more time on a broader benchmark. These plans are alternative ways to perform the same calibration, so they cannot both be selected for one profile.

Calibration time before a release is limited. We may skip some profiles and choose different measurement depths for others. Choices for different profiles do not exclude one another, but all experiments share the same total time limit.

There are `G` calibration profiles. Profile `g` offers `K_g` mutually exclusive measurement plans, each with an execution time and a confidence value. At most one plan may be chosen from a profile, and a profile may be skipped entirely.

Maximize total confidence subject to total time at most `C`. Plans are indivisible and cannot be repeated. The empty schedule is valid. Output only the maximum value.

## Input

The first line contains `G C`. Each profile is then given on one line:

```text
K time1 value1 time2 value2 ... timeK valueK
```

## Output

Output one line containing the maximum total confidence.

## Constraints

- `1 <= G <= 100`
- `0 <= C <= 100000`
- `1 <= K_g`
- `sum K_g <= 200`
- `0 <= time <= 100000`
- `0 <= value <= 10^12`
- The sum of all values is at most `9 * 10^18`.

Even if two plans have identical time and value, they remain alternatives in the same profile and cannot both be selected. The full limits and the 64 MiB memory limit rule out combination enumeration and a complete `O(GC)` table.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
3 7
2 2 4 4 8
2 3 7 5 10
1 2 5
```

Output:

```text
16
```

### Example Two

Input:

```text
2 0
3 0 5 0 7 1 100
2 0 4 0 3
```

Output:

```text
11
```

### Example Three

Input:

```text
3 5
1 6 100
1 5 9
2 2 3 3 4
```

Output:

```text
9
```

<!-- END GENERATED SAMPLES -->
