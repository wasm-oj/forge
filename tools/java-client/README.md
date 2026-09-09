# Java client toolchain

`build.py` builds the WasmGC Java compiler, javac SDK, and WASI runtime classlib from fixed public sources in a new output directory. It does not use Maven Local, a developer checkout's compiled classes, or an existing toolchain archive. Student programs still run as client-side WASI modules. There is no server fallback or legacy WebC compiler route.

## Rebuild

Prerequisites: Git, Python 3.10+, Node.js 24+, and JDK 21 (home containing `bin/` and `jmods/`). The verified host uses OpenJDK 21.0.12 and Node.js 24.18.0. Java patch releases/distributions can change bootstrap inputs; the build records their identities rather than claiming cross-JDK byte reproducibility.

```sh
python3 tools/java-client/build.py \
  --output /absolute/path/to/new-java-build \
  --jdk "$JAVA_HOME"
JAVA_OPTIMIZATION=debug node /absolute/path/to/new-java-build/teavm-javac/compiler/src/test/js/gc-parity.mjs \
  /absolute/path/to/new-java-build/compiler /absolute/path/to/new-java-build/classlibs \
  > /absolute/path/to/new-java-build/gc-debug.log
JAVA_OPTIMIZATION=release node /absolute/path/to/new-java-build/teavm-javac/compiler/src/test/js/gc-parity.mjs \
  /absolute/path/to/new-java-build/compiler /absolute/path/to/new-java-build/classlibs \
  > /absolute/path/to/new-java-build/gc-release.log
node scripts/import-java-client-toolchain.mjs /absolute/path/to/new-java-build
node scripts/build-library.mjs --group toolchain
node scripts/build-library.mjs --group code
node scripts/verify-java-client.mjs
```

Only downloads may be reused through `--cache`; every cached artifact is checked against its pinned SHA-256. The source checkouts use exact Git commits. Maven inputs and digests are in `dependencies.json`; all 23 URLs were verified reachable. The OpenJDK 21 javac source commit is `890adb6410dab4606a4f26a942aed02fb2f55387`, archive SHA-256 `016be5201082fb671d8622bed40a0a56c2b8c4b161da8a6a03b00b2f8a045e46`.

The recipe compiles all TeaVM core/classlib/platform/JSO implementation sources, matching the upstream Gradle dependency relocation rules. It rebuilds javac and its resource generators from OpenJDK source, compiles all wrapper/protocol/emulator sources, and assembles both classlibs from these classes plus pinned upstream resources. The compiler uses TeaVM's WasmGC ADVANCED target; student debug/release use SIMPLE/ADVANCED respectively. The prototype's old Gradle `NONE` enum maps to SIMPLE; it was not an invalid enum.

`teavm-core.patch` applies to `konsoletyper/teavm@b3a245b7d9034ff35cdfab2def057a3d4f256efb`; `teavm-javac.patch` applies to `konsoletyper/teavm-javac@7e4a44cf521694a4e326e33850dd8aec165eb5c9`. They include complete source changes, tests, and imported source/license files. The separate `*-original-prototype.patch` files preserve the pre-existing tracked dirty baseline for review and must not be applied in addition to the complete patches. Original developer checkouts were not modified.

## Root repairs

- The old compiler returned success for javac failures, backend failures, and caught exceptions. Its diagnostic WASI entrypoint now uses real `proc_exit` statuses. The active adapter consumes structured javac diagnostics as CE and retains backend/infrastructure exceptions as SE.
- The old linear-memory self-hosted compiler corrupted a class/vtable reference while compiling valid byte-input and BufferedReader/split programs. The same compiler implementation under the JVM compiled them successfully. WasmGC removes that compiler allocator from the active route; the exact corrupting legacy allocation was not isolated.
- Bootstrap disables annotation-based native-plugin discovery. Explicit registration of existing metadata/string, enum, Object.clone, arraycopy and reflection-array plugins repairs the generated program dependency graph.
- Complete, unchanged AOSP Scanner and Spliterators sources are vendored at `platform/libcore@de876a01b29230b877c9f408348c38a90ee724a5`, preserving GPL-2.0 with Classpath exception. TeaVM relocates their classes normally. Locale.Category, InputMismatchException, Integer.sum, Unicode numeric parsing, NaN/Infinity parsing, decimal suffix initialization, regex braced codepoints, and full CLDR locale resources provide their required standard-library behavior.
- UnicodeData First/Last ranges and RLE boundary/chunk/final-flush fixes follow upstream TeaVM `c209dd4fb9e2e8b14a14488d5f9f2aeb0b4ad74a`, files `UnicodeSupport.java` and `UnicodeHelper.java`. The named floating-point parser fix follows that upstream `TDouble.java`.
- Entry names come from javac's package symbols and source filenames, handling comments, text blocks, Unicode names and escapes without source regex parsing. Compiled class/superclass metadata validates `public static void main(String[])`. Missing or invalid entries generate a guest execution failure, not a source compilation error or compiler SE. A TeaVM-generated launcher initializes superclass-to-subclass and invokes inherited main correctly. Static initializer exceptions remain guest runtime failures.
- JSBody code is emitted into indexed compiler custom sections and packaged as static JavaScript factories. Runtime wrappers preserve arguments, receiver, variadics, constructors and exceptions without eval or Function construction. The verifier checks every emitted body and exact unique factory membership; seven method bodies currently share six unique factories.

## Evidence

Two independent source builds produced byte-identical final assets on the recorded host:

| Asset | SHA-256 |
| --- | --- |
| Compiler | `8c37bce1c6fceeaffeffe93e10834309b67c8b6fb58c6f8a24547afe8be67f5d` |
| SDK | `738a82b7d7e7ff8d98b07bb076785da7035847a166afb8446fd150c4efce6103` |
| Runtime classlib | `0ed234b66cdde19cb29e6c2865a3636d792d3cf72f102e73a7b3fdede80b79e6` |

The verified native parity run passed **19 cases in each of debug and release (38 executions total)** with exact asset hashes. The rebuild commands generate `gc-debug.log` and `gc-release.log` in the build output directory for import validation; generated logs are not committed. The harness disables JavaScript Function construction, compiles each source with both the browser compiler and OpenJDK 21, and compares execution stdout/exit. It covers Scanner APIs/locales/Unicode/streams, BufferedReader/split, regexes, collections, syntax errors, package/source-name edge cases, missing/invalid/inherited main, and initializer failures. The importer requires both log files, checks passing records, and rejects asset hash mismatches.

Browser evidence is `output/playwright/java-client/results.json`: 40 cases under CSP with WASM enabled and JS eval forbidden. The empty-program raw baseline remains debug 2907 / release 2419 for these exact assets. Native evidence, browser evidence, package build, and production deployment are distinct checks.

Focused tests additionally cover compiler CE/SE boundaries, generated-WASM validation, 12 Unicode RLE round trips, and seven static runtime-wrapper semantics. Original production failure traces remain in the isolated Java investigation checkout's `output/java-reliability/`.

## Limits

The test corpus establishes the reproduced behaviors, not complete OpenJDK API compatibility or exact native-JVM resource equivalence. TeaVM exception stderr formatting differs from JVM output and optimized traces can omit exception class/message text. Unsupported classlib/backend operations remain explicit infrastructure failures. Browser WasmGC support is required.
