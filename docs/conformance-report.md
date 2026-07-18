# Forge contract 1 conformance and efficiency report

Forge contract 1 is the first formal compatibility boundary and includes the
complete compiler, runner, deterministic virtual-clock, metering, resource,
judge, and library behavior. The current preregistered evidence is maintained
under the single [contract 1 conformance experiment](../experiments/forge-contract-1-conformance/).

<!-- forge-conformance-summary:start -->
This report records real local server and browser runs on 2026-07-18
(Asia/Taipei). The canonical matrix is generated from independent append-only
evidence records under `wasm-oj-forge-v1`; it is not a synthetic estimate.
<!-- forge-conformance-summary:end -->

The canonical JSON matrix records the exact source-tree and specification
digests for both raw inputs. Publication rejects records that do not match each
other or the source and specification present at publication time.

## Recorded contract

- Forge contract 1 jointly versions compiler, runner, determinism, metering,
  artifacts, judge specifications, caches, and conformance schemas. There are
  no independent subsystem contract counters.
- Pinned content: Clang 22 for C17/C++20, Rust 1.91.1-dev, Go 1.26.5,
  CPython 3.14.6, TypeScript 7.0.2, and QuickJS-ng 0.15.1.
- Runtime: the shared Rust runtime core uses Wasmer 7.2.0 and WASIX 0.702.0;
  browser compiler and package execution use `@wasmer/sdk` 0.10.0.
- Weighted meter model `weighted` under Forge contract 1, with opcode weights
  adapted from Binaryen's optimizer cost model and preserved for WARK 0.3
  compatibility.
- Every server case performs two uncached builds and three deterministic runs.
  A pass requires equal build digests, the declared output/termination, and an
  identical deterministic transcript across all three runs.
- Empty-program baselines were recalibrated across all 18
  language/target/optimization profiles and five seeds. All 90 executions
  produced seed-independent raw costs; a separate nine-profile production
  smoke confirmed `net = 0` and `raw = baseline` for every release profile.

## Browser/server conformance

<!-- forge-conformance-matrix:start -->
All 21 declared language/target cases passed independently in
`server-native` and `browser-wasmer-js`. The canonical comparison contains zero
mismatches: every artifact digest and every deterministic transcript field is
identical across hosts. Timing remains observational and is excluded from
compatibility.

| Case | Artifact | Bytes | Net / raw / baseline | Server compile 1 / 2 | Browser compile 1 / 2 | Median run server / browser |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| C / wasip1 | `18662d3e…b9b29` | 45,625 | 5,445 / 5,591 / 146 | 1,688 ms / 1,485 ms | 1,187 ms / 1 ms | 34 ms / 8 ms |
| C / wasip1 / filesystem metadata | `91f788d7…b3549` | 33,056 | 15,427 / 15,573 / 146 | 1,784 ms / 1,769 ms | 175 ms / 1 ms | 28 ms / 6 ms |
| C / wasip1 / multi-file IO | `d2c40caa…a5bc3` | 49,908 | 16,883 / 17,029 / 146 | 1,747 ms / 1,755 ms | 175 ms / 768 ms | 32 ms / 8 ms |
| C / wasip1 / filesystem write limit | `26558a2c…3d068` | 18,945 | 6,219 / 6,365 / 146 | 1,724 ms / 1,730 ms | 329 ms / 1 ms | 18 ms / 3 ms |
| C / WASIX | `ff412007…4473c` | 4,064 | 1,138 / 1,284 / 146 | 1,706 ms / 1,693 ms | 160 ms / 1 ms | 8 ms / 1 ms |
| C / WASIX / denied thread_spawn | `c6ac35d1…81e16` | 1,072 | 0 / 133 / 146 | 1,621 ms / 1,695 ms | 167 ms / 723 ms | 6 ms / 1 ms |
| C++ / wasip1 | `b73a8158…d923f` | 4,059 | 934 / 1,080 / 146 | 1,709 ms / 1,734 ms | 553 ms / 1 ms | 9 ms / 1 ms |
| C++ / WASIX | `01966026…eb47e` | 4,059 | 934 / 1,080 / 146 | 1,756 ms / 1,746 ms | 83 ms / 1 ms | 9 ms / 1 ms |
| Rust / wasip1 | `f84d1972…922d8` | 142,818 | 14,761 / 24,243 / 9,482 | 2,865 ms / 2,967 ms | 2,610 ms / 476 ms | 39 ms / 14 ms |
| Python / wasip1 | `21068a97…a0e66` | 1,851 | 170,594 / 2,420,004,603 / 2,419,834,009 | 16,378 ms / 16,376 ms | 1,438 ms / 436 ms | 1,043 ms / 780 ms |
| JavaScript / wasip1 | `4b161551…8dfbe` | 1,902 | 3,598,245 / 13,183,230 / 9,584,985 | 2,368 ms / 2,198 ms | 1,689 ms / 1,908 ms | 224 ms / 164 ms |
| TypeScript / wasip1 | `e464cd52…49429` | 1,925 | 3,568,036 / 13,153,021 / 9,584,985 | 1,780 ms / 1,789 ms | 1,431 ms / 1,443 ms | 233 ms / 163 ms |
| Go / wasip1 | `6a4e2b66…a89ef` | 2,550,145 | 429,396 / 2,136,517 / 1,707,121 | 2,844 ms / 2,524 ms | 1,576 ms / 383 ms | 357 ms / 273 ms |
| C / wasip1 / virtual clock | `8b1002ba…3e198` | 18,565 | 8,022 / 8,168 / 146 | 1,800 ms / 1,778 ms | 1,079 ms / 1 ms | 19 ms / 3 ms |
| C / wasip1 / logical time limit | `3b7bfb51…867d1` | 1,254 | 51 / 197 / 146 | 1,740 ms / 1,747 ms | 341 ms / 1 ms | 6 ms / 0 ms |
| C++ / wasip1 / virtual sleep | `bb9c9846…f9b31` | 23,327 | 4,985 / 5,131 / 146 | 1,832 ms / 1,825 ms | 219 ms / 721 ms | 22 ms / 4 ms |
| Rust / wasip1 / virtual sleep | `5486f059…6922f` | 168,053 | 16,640 / 26,122 / 9,482 | 2,952 ms / 2,796 ms | 2,541 ms / 572 ms | 40 ms / 15 ms |
| Python / wasip1 / virtual sleep | `34213784…6f24a` | 2,041 | 185,316 / 2,420,019,325 / 2,419,834,009 | 8,280 ms / 8,286 ms | 1,462 ms / 432 ms | 1,025 ms / 774 ms |
| JavaScript / wasip1 / virtual clock | `092f667b…ef276` | 1,948 | 27,430,723 / 37,015,708 / 9,584,985 | 1,785 ms / 1,772 ms | 1,800 ms / 1,441 ms | 227 ms / 165 ms |
| TypeScript / wasip1 / virtual clock | `bb1ac027…60cb2` | 1,948 | 27,430,723 / 37,015,708 / 9,584,985 | 1,787 ms / 2,096 ms | 1,690 ms / 1,831 ms | 225 ms / 164 ms |
| Go / wasip1 / virtual sleep | `28e01807…24baf` | 2,561,512 | 589,026 / 2,296,147 / 1,707,121 | 2,508 ms / 2,512 ms | 840 ms / 388 ms | 363 ms / 274 ms |
<!-- forge-conformance-matrix:end -->

The default panel contains all 21 execution cases shown above: the nine
language/target profiles plus deterministic filesystem, multi-file I/O,
write-time VFS quota, denied capability, and language-level virtual-clock
probes. The opt-in full panel adds the header-heavy C++ standard-library and
PCH case.

Python has the largest fixed runtime cost, but normalization removes only its
measured empty-program startup. Parsing/loading the submission, deterministic
API use, input, allocation, I/O, and user code remain charged. Raw cost and the
complete opcode map remain in every transcript.

See the recorded [contract 1 conformance evidence](../experiments/forge-contract-1-conformance/),
[contract 1 cost calibration](../experiments/forge-contract-1-cost-baseline/).
