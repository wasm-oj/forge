# Editorial

## Intuitive Approach

Let `T` be the number of instructions after expanding all runs. Simulating from the first instruction for every budget takes `O(QT)` time. Even retaining the run-length encoding but subtracting one run at a time still takes `O(QR)`, which is too slow for `R,Q=200000`.

## Optimal Approach: Run Prefix Sums

Initialize `weight[1..K]` to `1000`, then overwrite the explicitly listed weights. For run `i`, compute:

- `prefixCost[i]`: the cost of the first `i` complete runs;
- `prefixCount[i]`: the number of instructions in the first `i` complete runs.

Both arrays start with zero at index `0`. For a budget `B`, use `upper_bound(prefixCost, B)-1` to find the largest number `i` of complete runs that fit. If `i<R`, let `remaining=B-prefixCost[i]`. The number of instructions that can additionally be taken from the next run is

```text
take = min(nextCount, remaining / nextWeight)
```

Add `take` to the corresponding prefix values to obtain the answer.

## Correctness Proof

Because every weight and count is positive, `prefixCost` is strictly increasing. Therefore the binary search returns exactly the largest complete-run prefix whose cost does not exceed `B`. Any longer valid prefix that still ends inside the next run can contain only more instructions of that run's fixed weight. Integer division `remaining/nextWeight` is exactly the maximum number that can be paid for, and `min` prevents passing the end of the run. Taking one additional instruction would exceed the remaining budget. Thus the algorithm returns the unique longest legal instruction prefix, and the reported cost is the cost of that same prefix.

## Complexity

Building the weight table and prefix sums takes `O(K+R)` time. Each query takes `O(log R)`, for total time `O(K+R+Q log R)`. The core auxiliary space is `O(K+R)`. The C, C++, and Go references stream input and output; the Rust and Python references buffer all input and output; JavaScript and TypeScript retain one input string and use fixed-size output chunks. Accounting for actual resident allocations, the common worst-case space bound across all seven references is `O(K+R+Q)`.

## Common Mistakes

- Forgetting that every unlisted opcode has weight `1000`.
- Storing costs in floating point, or in JavaScript `number`; use a 64-bit integer or `bigint`.
- Treating a cost exactly equal to the budget as unaffordable.
- Counting only complete runs after the binary search and omitting the affordable part of the next run.
