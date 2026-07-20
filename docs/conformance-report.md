# Forge contract 1 conformance and efficiency report

Forge contract 1 is the first formal compatibility boundary and includes the
complete compiler, runner, deterministic virtual-clock, metering, resource,
judge, and library behavior. The current preregistered evidence is maintained
under the single [contract 1 conformance experiment](../experiments/forge-contract-1-conformance/).

<!-- forge-conformance-summary:start -->
This report records real local server and browser runs on 2026-07-20
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
| C / wasip1 | `b195a678…f952b` | 45,625 | 5,445 / 5,591 / 146 | 1,601 ms / 1,831 ms | 1,281 ms / 1 ms | 31 ms / 8 ms |
| C / wasip1 / filesystem metadata | `856e2fe9…c013e` | 33,056 | 15,427 / 15,573 / 146 | 1,562 ms / 1,628 ms | 186 ms / 1 ms | 29 ms / 6 ms |
| C / wasip1 / multi-file IO | `334dab5d…3bf97` | 49,908 | 16,883 / 17,029 / 146 | 1,597 ms / 1,861 ms | 171 ms / 764 ms | 34 ms / 9 ms |
| C / wasip1 / filesystem write limit | `b3d8825f…4f79a` | 18,945 | 6,219 / 6,365 / 146 | 1,598 ms / 1,595 ms | 339 ms / 1 ms | 18 ms / 3 ms |
| C / WASIX | `c3928999…8cd19` | 4,064 | 1,138 / 1,284 / 146 | 1,587 ms / 1,521 ms | 317 ms / 1 ms | 8 ms / 1 ms |
| C / WASIX / denied thread_spawn | `432af0c8…210a7` | 1,072 | 0 / 133 / 146 | 1,506 ms / 1,578 ms | 169 ms / 767 ms | 6 ms / 1 ms |
| C++ / wasip1 | `db897e4f…bb50d` | 4,059 | 934 / 1,080 / 146 | 1,638 ms / 1,633 ms | 555 ms / 1 ms | 9 ms / 1 ms |
| C++ / WASIX | `e5f96539…40e11` | 4,059 | 934 / 1,080 / 146 | 1,620 ms / 1,631 ms | 87 ms / 1 ms | 9 ms / 1 ms |
| Rust / wasip1 | `05fcf6e0…6fac0` | 142,818 | 14,761 / 24,243 / 9,482 | 3,172 ms / 3,162 ms | 2,690 ms / 597 ms | 43 ms / 14 ms |
| Python / wasip1 | `98561f95…ac712` | 1,851 | 4,632,241 / 2,424,466,250 / 2,419,834,009 | 16,376 ms / 16,394 ms | 1,478 ms / 455 ms | 1,097 ms / 799 ms |
| JavaScript / wasip1 | `673f1db6…927a7` | 1,902 | 4,489,846 / 14,074,831 / 9,584,985 | 2,296 ms / 2,302 ms | 2,028 ms / 1,474 ms | 239 ms / 165 ms |
| TypeScript / wasip1 | `8cc8d4b3…83ae4` | 1,925 | 4,514,568 / 14,099,553 / 9,584,985 | 1,912 ms / 1,883 ms | 1,455 ms / 1,479 ms | 232 ms / 165 ms |
| Go / wasip1 | `39d6cb9e…596fb` | 2,550,145 | 429,396 / 2,136,517 / 1,707,121 | 3,441 ms / 2,705 ms | 1,695 ms / 425 ms | 364 ms / 274 ms |
| C / wasip1 / virtual clock | `f72e1525…dc27b` | 18,565 | 8,022 / 8,168 / 146 | 1,542 ms / 1,517 ms | 1,154 ms / 1 ms | 19 ms / 3 ms |
| C / wasip1 / logical time limit | `feae5bbd…e648d` | 1,254 | 51 / 197 / 146 | 1,510 ms / 1,535 ms | 364 ms / 1 ms | 7 ms / 0 ms |
| C++ / wasip1 / virtual sleep | `7ef531ef…2cba1` | 23,327 | 4,985 / 5,131 / 146 | 1,873 ms / 1,611 ms | 236 ms / 765 ms | 23 ms / 4 ms |
| Rust / wasip1 / virtual sleep | `28b9dca7…7e74d` | 168,053 | 16,640 / 26,122 / 9,482 | 3,065 ms / 3,093 ms | 2,756 ms / 587 ms | 40 ms / 15 ms |
| Python / wasip1 / virtual sleep | `3b6e2b1c…5830b` | 2,041 | 4,648,726 / 2,424,482,735 / 2,419,834,009 | 16,403 ms / 16,393 ms | 1,463 ms / 455 ms | 1,091 ms / 774 ms |
| JavaScript / wasip1 / virtual clock | `77fedb77…d488f` | 1,948 | 28,374,535 / 37,959,520 / 9,584,985 | 1,962 ms / 1,851 ms | 1,450 ms / 1,465 ms | 233 ms / 166 ms |
| TypeScript / wasip1 / virtual clock | `3cd0cb23…bcab5` | 1,948 | 28,374,535 / 37,959,520 / 9,584,985 | 2,306 ms / 2,277 ms | 1,761 ms / 1,473 ms | 232 ms / 165 ms |
| Go / wasip1 / virtual sleep | `8a7e09d7…3c07f` | 2,561,512 | 589,026 / 2,296,147 / 1,707,121 | 2,703 ms / 2,727 ms | 890 ms / 406 ms | 362 ms / 276 ms |
<!-- forge-conformance-matrix:end -->

The default panel contains all 21 execution cases shown above: the nine
language/target profiles plus deterministic filesystem, multi-file I/O,
write-time VFS quota, denied capability, and language-level virtual-clock
probes. The opt-in full panel adds the header-heavy C++ standard-library case.
The new canonical header path now selects the toolchain-admitted release PCH;
a real native Wasmer smoke on the current source compiled it in about 4.1
seconds and executed successfully. That targeted attempt is retained as
append-only raw evidence, but it is not merged into the 21-case browser/server
matrix above until a new full two-host publication is collected.

Python has the largest fixed runtime cost, but normalization removes only its
measured empty-program startup. Parsing/loading the submission, deterministic
API use, input, allocation, I/O, and user code remain charged. Raw cost and the
complete opcode map remain in every transcript.

See the recorded [contract 1 conformance evidence](../experiments/forge-contract-1-conformance/),
[contract 1 cost calibration](../experiments/forge-contract-1-cost-baseline/).
