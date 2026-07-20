## Inspiration

Online judging has a resource problem.

Every compilation, sample run, custom test case, and resubmission consumes server CPU and memory. This becomes especially expensive in education, where learners are expected to experiment frequently—and are also more likely to accidentally submit infinite loops, excessive allocations, or algorithms that exceed their intended complexity.

A traditional online judge must provision enough infrastructure for all of that work. As more learners arrive, compilation and execution become a centralized scalability bottleneck.

The obvious solution is to move some of the work to the user’s own device. Modern browsers are capable execution environments. If learners can compile and test locally, a platform can serve many more users without scaling server capacity at the same rate.

But that creates a second problem.

A fast desktop, an older laptop, a busy server, and a throttled browser do not execute a program in the same amount of wall-clock time. Even on the same machine, the same program may appear faster or slower depending on background activity and changing system conditions.

If judging depends on elapsed time, distributing execution across heterogeneous devices makes results inconsistent.

That became the central question behind WASM-OJ:

> **How can we distribute compilation and execution without distributing the meaning of the result?**

## Our Answer

WASM-OJ is a distributed, multi-language online judge that can compile and execute submissions in the browser or on the server while preserving consistent execution and judging semantics.

It uses WebAssembly and WASI as a portable execution foundation and measures computational work through a deterministic, host-independent resource model. Host speed may change how long a learner waits, but it does not change how much work the judge records.

The learner’s device can perform compilation and test execution, while the platform retains a reproducible basis for resource limits and verdicts.

Our guiding principle is:

> **Scale the judge, not the server.**

## What We Built

WASM-OJ turns the browser into a self-contained programming and judging environment. It supports both compiled and interpreted languages through a shared portable execution model.

Learners can:

- Write and build programs in the browser
- Run sample and custom tests locally
- Receive structured compilation, execution, and resource-limit feedback
- Preserve their work and iterate without creating a server job for every attempt

The same conceptual boundaries support server-side execution. A platform can choose where each workload runs while preserving one judging model.

## Why WebAssembly and WASI

WebAssembly provides a portable execution model and a sandboxed boundary. WASI gives programs a consistent interface to their surrounding environment. Together, they allow the same program artifact to run across operating systems and hardware architectures.

Portability alone does not guarantee reproducible behavior. Programs can observe time, randomness, files, process settings, and other environmental state. WASM-OJ brings these sources of variation under an explicit execution policy.

Given the same program, input, and configuration, browser and server executions can therefore be evaluated under the same rules for observable behavior, resource use, and judging.

## Measuring Work Instead of Waiting for Time

Wall-clock duration remains useful for understanding the learner’s experience. The portable resource signal, however, is a deterministic measure of executed work.

This separates the meaning of a result from the speed and current load of the host device. A slower machine may finish later, but it receives the same deterministic cost for the same execution. Runaway programs stop when they exhaust a defined work budget instead of consuming resources until an unreliable time threshold is reached.

Different language environments also carry different amounts of fixed startup work. WASM-OJ normalizes that overhead so the reported measurement better reflects the work associated with the submitted program and its input. This creates a common basis for reasoning about compiled and interpreted languages without requiring identical implementations.

The resulting measurement is an empirical signal, not an automatic inference of asymptotic complexity. Learners can run increasing input sizes and observe how measured work grows without the comparison being dominated by server load or device speed.

## A Complete Learning Experience

The execution model is presented through a complete browser-based learning experience. Learners can write programs, inspect build feedback, run sample and judge cases, preserve their progress, and understand why an execution reached a resource limit.

Because ordinary edit–test cycles happen locally, experimentation remains fast and places little incremental demand on centralized infrastructure.

## Architecture

The system separates three responsibilities:

1. Compilation turns a source project into a portable program artifact.
2. Execution runs that artifact under an explicit and reproducible resource policy.
3. Judging evaluates test cases and produces structured verdicts.

Browser and server environments implement these responsibilities through the same contracts. This gives deployments the freedom to distribute ordinary compilation and testing to browsers while reserving server execution for official validation, unsupported environments, or centrally controlled workloads.

## The Hardest Challenges

### Bringing real language environments to the browser

Learners should encounter the languages they expect, including their normal compilation and runtime behavior. Delivering that experience inside a browser requires language environments that remain portable, complete, and practical on a user’s device.

### Keeping local compilation safe and responsive

Compilation can be intensive, and submitted programs can fail in unpredictable ways. Local execution must remain isolated, bounded, and responsive throughout repeated edit–test cycles.

### Making computational work comparable

Compiled and interpreted languages reach user code through very different execution paths. A useful cross-language resource model must account for fixed environmental overhead while preserving the work caused by the program and its input. The measurement policy must also remain explicit and reproducible as language support evolves.

## How We Used Codex and GPT-5.6

Codex served as an engineering collaborator throughout the project. It helped us study earlier prototypes, clarify the invariants the new system needed to preserve, design shared boundaries, implement and debug the system, and build experiments and regression tests.

The central product decisions remained explicit: distribute ordinary workloads to learner devices, treat server execution as another host under the same semantics, and measure portable computational work independently of elapsed time. Behavioral and performance claims were accepted only when supported by executable evidence.

## What Was New During Build Week

WASM-OJ succeeds earlier experiments, but the integrated system was substantially rebuilt during Build Week. The new work established:

- Practical multi-language compilation and execution in the browser
- Shared browser and server judging semantics
- Deterministic execution and resource measurement across language environments
- Conformance and performance evidence for the integrated system
- A complete learner-facing online judge experience

## Impact

For learners, WASM-OJ enables fast local experimentation and provides a stable way to observe how program cost grows across inputs.

For educators, it reduces the infrastructure required to serve a classroom while preserving consistent judge semantics across student devices.

For online-judge platforms, it turns every capable browser into a compilation and execution worker. Server resources can focus on official submissions, unsupported environments, and workloads that require centralized control.

For researchers and language-tooling developers, it provides an auditable environment for comparing compilation, execution, and resource measurement across languages and hosts.

## What We Learned

Distributed execution and reproducible execution must be designed together.

Moving computation to users addresses the infrastructure bottleneck but introduces hardware diversity. WebAssembly and WASI provide a portable environment; deterministic resource measurement provides a portable definition of computational work.

Together, they make it possible to distribute the cost of judging without changing the meaning of the result.

## What’s Next

The core computation and runtime layer is now in place. Our next phase is the open ecosystem around it: storage, persistence, portability, and sharing.

First, we plan to define a standard, Git-based repository format for problem collections. A compatible browser judge should be able to load a chosen repository and turn it directly into a practice environment. Educators and problem authors could publish, version, fork, and recombine problem sets without coupling them to a single platform.

Second, we plan to define a Git-based repository format for learner-owned records. Because compilation, execution, and judging can happen in the browser, each submission can be preserved with its source code and evaluation record. GitHub or another compatible repository host can provide synchronization and version history, allowing a learner’s work and progress to remain durable, portable, and traceable across sessions and tools.

Together, these two repository standards connect shared learning material with personal learning history. One describes what can be learned; the other records the path each learner takes through it.

Our long-term goal is an open learning ecosystem in which anyone can publish a problem collection, any compatible browser-based judge can turn it into a local practice environment, and every learner can carry a durable history of their work across platforms.
