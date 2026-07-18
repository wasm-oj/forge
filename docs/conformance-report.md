# Forge contract 1 conformance and efficiency report

Forge contract 1 is the first formal compatibility boundary and includes the
complete compiler, runner, deterministic virtual-clock, metering, resource,
judge, and library behavior. The current preregistered evidence is maintained
under the single [contract 1 conformance experiment](../experiments/forge-contract-1-conformance/).

<!-- forge-conformance-summary:start -->
This report records real local server and browser runs on 2026-07-19
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
| C / wasip1 | `b195a678…f952b` | 45,625 | 5,445 / 5,591 / 146 | 1,827 ms / 1,765 ms | 1,233 ms / 2 ms | 41 ms / 9 ms |
| C / wasip1 / filesystem metadata | `856e2fe9…c013e` | 33,056 | 15,427 / 15,573 / 146 | 1,770 ms / 1,802 ms | 179 ms / 1 ms | 27 ms / 6 ms |
| C / wasip1 / multi-file IO | `334dab5d…3bf97` | 49,908 | 16,883 / 17,029 / 146 | 1,788 ms / 1,780 ms | 165 ms / 743 ms | 32 ms / 9 ms |
| C / wasip1 / filesystem write limit | `b3d8825f…4f79a` | 18,945 | 6,219 / 6,365 / 146 | 1,773 ms / 1,785 ms | 337 ms / 19 ms | 19 ms / 3 ms |
| C / WASIX | `c3928999…8cd19` | 4,064 | 1,138 / 1,284 / 146 | 1,754 ms / 1,547 ms | 294 ms / 1 ms | 9 ms / 1 ms |
| C / WASIX / denied thread_spawn | `432af0c8…210a7` | 1,072 | 0 / 133 / 146 | 1,582 ms / 1,757 ms | 160 ms / 731 ms | 6 ms / 1 ms |
| C++ / wasip1 | `db897e4f…bb50d` | 4,059 | 934 / 1,080 / 146 | 1,861 ms / 1,616 ms | 533 ms / 1 ms | 9 ms / 1 ms |
| C++ / WASIX | `e5f96539…40e11` | 4,059 | 934 / 1,080 / 146 | 1,791 ms / 1,596 ms | 89 ms / 1 ms | 9 ms / 1 ms |
| Rust / wasip1 | `05fcf6e0…6fac0` | 142,818 | 14,761 / 24,243 / 9,482 | 3,069 ms / 3,079 ms | 2,615 ms / 601 ms | 37 ms / 14 ms |
| Python / wasip1 | `98561f95…ac712` | 1,851 | 4,632,241 / 2,424,466,250 / 2,419,834,009 | 16,371 ms / 16,385 ms | 1,457 ms / 445 ms | 1,078 ms / 765 ms |
| JavaScript / wasip1 | `673f1db6…927a7` | 1,902 | 4,489,846 / 14,074,831 / 9,584,985 | 2,243 ms / 1,732 ms | 2,000 ms / 2,013 ms | 228 ms / 163 ms |
| TypeScript / wasip1 | `8cc8d4b3…83ae4` | 1,925 | 4,514,568 / 14,099,553 / 9,584,985 | 2,246 ms / 1,873 ms | 1,438 ms / 1,468 ms | 232 ms / 162 ms |
| Go / wasip1 | `39d6cb9e…596fb` | 2,550,145 | 429,396 / 2,136,517 / 1,707,121 | 3,335 ms / 2,580 ms | 1,612 ms / 392 ms | 363 ms / 273 ms |
| C / wasip1 / virtual clock | `f72e1525…dc27b` | 18,565 | 8,022 / 8,168 / 146 | 1,829 ms / 1,795 ms | 1,090 ms / 1 ms | 18 ms / 3 ms |
| C / wasip1 / logical time limit | `feae5bbd…e648d` | 1,254 | 51 / 197 / 146 | 1,479 ms / 1,760 ms | 327 ms / 1 ms | 6 ms / 0 ms |
| C++ / wasip1 / virtual sleep | `7ef531ef…2cba1` | 23,327 | 4,985 / 5,131 / 146 | 1,578 ms / 1,846 ms | 224 ms / 742 ms | 21 ms / 4 ms |
| Rust / wasip1 / virtual sleep | `28b9dca7…7e74d` | 168,053 | 16,640 / 26,122 / 9,482 | 2,944 ms / 3,013 ms | 2,551 ms / 573 ms | 39 ms / 15 ms |
| Python / wasip1 / virtual sleep | `3b6e2b1c…5830b` | 2,041 | 4,648,726 / 2,424,482,735 / 2,419,834,009 | 16,393 ms / 8,294 ms | 1,447 ms / 440 ms | 1,052 ms / 787 ms |
| JavaScript / wasip1 / virtual clock | `77fedb77…d488f` | 1,948 | 28,374,535 / 37,959,520 / 9,584,985 | 1,842 ms / 1,814 ms | 1,464 ms / 1,445 ms | 229 ms / 163 ms |
| TypeScript / wasip1 / virtual clock | `3cd0cb23…bcab5` | 1,948 | 28,374,535 / 37,959,520 / 9,584,985 | 2,063 ms / 2,121 ms | 1,731 ms / 1,541 ms | 226 ms / 162 ms |
| Go / wasip1 / virtual sleep | `8a7e09d7…3c07f` | 2,561,512 | 589,026 / 2,296,147 / 1,707,121 | 2,622 ms / 2,647 ms | 865 ms / 386 ms | 365 ms / 274 ms |
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
