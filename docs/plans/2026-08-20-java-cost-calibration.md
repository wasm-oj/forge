# Java Cost Calibration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship measured Java WASI empty-program baselines so Java startup overhead is excluded from reported net instruction cost.

**Architecture:** Keep calibration keyed by the exact compiler/runtime cost profile. The default registry contains only the pinned Java profiles measured in this branch; caller-provided entries override those values. A Java artifact with a missing profile fails closed, while existing non-Java downstream profiles continue to be supplied by their host.

**Tech Stack:** TypeScript, Vitest, existing weighted Wasm meter, server-native conformance runner.

---

### Task 1: Measure both Java optimization profiles

**Files:**
- No product files.
- Evidence: `experiments/wasm-oj-contract-2-conformance/runs/raw/records/*.json`

**Steps:**

1. Compile and run an empty Java `main` with release and debug optimization through conformance cases.
2. Repeat each artifact enough times to confirm deterministic raw cost.
3. Record the exact profile IDs and measured baselines in conformance evidence.

### Task 2: Add calibrated registry data and regression tests

**Files:**
- Create: `src/core/cost-baselines.ts`
- Modify: `src/core/cost.ts`
- Modify: `src/core/cost.test.ts`

**Steps:**

1. Register the exact Java release/debug profiles with the measured values.
2. Preserve caller overrides for recalibration and downstream profiles.
3. Test default lookup, override behavior, and net-cost subtraction.

### Task 3: Exercise calibration through the server path

**Files:**
- Modify: `src/server/conformance.integration.test.ts`
- Modify: `docs/java-wasi-toolchain-rfc.md`

**Steps:**

1. Run Java conformance through the default server registry, including real empty release/debug cases.
2. Assert successful Java executions satisfy `rawCost = cost + baselineCost` and expose a non-zero baseline.
3. Document that compile wall time is separate from deterministic net instruction cost.

### Task 4: Verify the full repository

**Files:**
- No further source changes unless a failing check identifies one.

**Steps:**

1. Run focused cost and Java tests.
2. Run full server conformance for all declared cases, including the full suite.
3. Run typecheck, lint, full tests, docs, licenses, library, and toolchain checks.
4. Inspect the final diff and branch state before reporting.
