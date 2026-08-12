# Demo narration

## 1. WASM OJ Forge

Online judging has a resource problem. Every compilation and test consumes centralized server capacity. Moving that work into the browser solves scaling, but creates another problem. Wall-clock timing changes across devices. WASM OJ Forge asks: how can we distribute execution without changing what the result means? Our answer measures reproducible computational work instead of machine speed.

## 2. Architecture

The design follows one clear boundary. The browser downloads and verifies problem bundles and pinned toolchains. Your source code, inputs, outputs, build artifacts, and verdicts stay on your device. Real language toolchains produce portable WebAssembly programs inside isolated workers. Wasmer then runs them under deterministic limits for instruction cost, logical time, memory, output, and the virtual file system.

## 3. Compile

The interface keeps the familiar online judge workflow. Learners can browse forty-five bilingual systems problems and choose from seven languages. Progressive scoring rules explain how each solution earns points. Monaco supports multi-file editing. Here, this C solution compiles entirely inside the browser. No source file, and no compilation job, is uploaded.

## 4. Self test

Before submitting, the learner can run any custom input against the latest artifact. The result shows standard output, exit status, peak memory, and logical time. It also reports a normalized instruction cost. That budget is deterministic. A slow laptop and a fast desktop can apply the same policy.

## 5. Judge

Submit runs the complete test set locally. This solution passes all four cases and earns one hundred points. Each case keeps its own cost and memory evidence. That same evidence supports progressive scoring when a solution passes only a broader resource tier. The verdict is inspectable, educational, and reproducible.

## 6. Codex and GPT-5.6

Codex with GPT five point six was our engineering partner throughout Build Week. It helped us recover invariants from earlier prototypes. We used it to design shared browser and server contracts, implement seven language toolchains, and debug isolation boundaries. It also helped create conformance and regression tests. We kept product decisions explicit. We accepted performance claims only when executable evidence supported them. WASM OJ Forge lets classrooms scale the judge without scaling the server.
