# Editorial

## Intuitive Approach

Enumerating whether to select each test and combining coverage takes `O(2^N(N + F))` time. Greedily choosing the best new-coverage-to-cost ratio is also incorrect because overlaps change every later marginal gain.

## Optimal Approach: Minimum Cost per Coverage Mask

Since `F <= 20`, represent a feature set by an `F`-bit mask. Let `dp[mask]` be the minimum cost of a subset of the tests processed so far whose union is exactly `mask`. Mark unreachable states with a true infinity and initialize only `dp[0] = 0`.

For a test `(cost, testMask)`, first copy `next = dp`, representing omission. For every reachable `mask`, update

```text
next[mask | testMask] = min(next[mask | testMask], dp[mask] + cost)
```

After all tests, inspect every `mask` with `dp[mask] <= B` and take the maximum population count.

## Correctness Proof

Induct on the processed tests. Initially, the empty subset is the unique possibility, so only mask zero is reachable at cost zero. For a new test, every subset either omits it, in which case the old state is preserved, or includes it. Removing the new test from the latter leaves some old union `mask`; restoring it creates exactly `mask | testMask` and adds exactly its cost. The transition enumerates both exhaustive cases and takes the minimum cost for every resulting union.

Thus the final DP gives the minimum cost for every achievable coverage set. Masks whose minimum cost is at most `B` correspond exactly to legal selections, and the maximum popcount among them is the required answer.

## Complexity

There are `2^F` masks and each test scans them once, for `O(N 2^F)` time and `O(2^F)` space.

## Common Mistakes

- Counting repeated coverage more than once and producing an answer greater than `F`.
- Using `sum(cost) + 1` as an unreachable sentinel and then accepting every value at most `B`; when `B > sum(cost)`, that sentinel appears feasible. Use a value beyond both the budget and every reachable cost, and never transition from it.
- Masking tests rather than features and returning to `2^N` enumeration.
- Ignoring zero-cost tests or tests with empty coverage.
