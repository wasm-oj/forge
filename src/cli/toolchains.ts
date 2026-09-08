import type { Language, OptimizationLevel, TargetAbi, ToolchainDescriptor } from "@wasm-oj/core";

type Asset = ToolchainDescriptor["assets"][number];

function profiles(languages: readonly Language[], targets: readonly TargetAbi[]) {
  return languages.flatMap((language) => targets.flatMap((target) => (["debug", "release"] as const).map((optimization: OptimizationLevel) => ({ language, target, optimization }))));
}

function descriptor(input: {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly Language[];
  readonly targets: readonly TargetAbi[];
  readonly assets: readonly Asset[];
}): ToolchainDescriptor {
  return Object.freeze({
    schema: "wasm-oj-v2/toolchain-package",
    id: input.id,
    version: input.version,
    wasmOjContract: 2,
    languages: Object.freeze([...input.languages]),
    profiles: Object.freeze(profiles(input.languages, input.targets).map((profile) => Object.freeze(profile))),
    assets: Object.freeze(input.assets.map((asset) => Object.freeze(asset))),
  });
}

export const CLI_TOOLCHAIN_DESCRIPTORS: readonly ToolchainDescriptor[] = Object.freeze([
  descriptor({
    id: "clang", version: "22.0.0-git20542-10", languages: ["c", "cpp"], targets: ["wasip1", "wasix"],
    assets: [
      { path: "/toolchains/clang-22.0.0-git20542-10.cc1-pins.json", bytes: 7845, sha256: "895eee17c63b1112c84adcc4ddbcb38e0c18e53bff15f50a8689b9b82d87b1ff", exportPath: "./assets/clang-22.0.0-git20542-10.cc1-pins.json" },
      { path: "/toolchains/clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin", bytes: 14579070, sha256: "a3811351bae3289caf096f2d4bb6d2ee5db84b97e05514e87190d36b65c500cf", exportPath: "./assets/clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin" },
      { path: "/toolchains/clang-22.0.0-git20542-10.cpp-release.pch.gz.bin", bytes: 14579316, sha256: "ef004fc05ec50af697a37f7c9c814bf62e9676d0de162d6ac35305533939f93f", exportPath: "./assets/clang-22.0.0-git20542-10.cpp-release.pch.gz.bin" },
      { path: "/toolchains/clang-22.0.0-git20542-10.libcxx-pch.json", bytes: 1987, sha256: "9bbe41d77c786f1c36169369c909268530b05726e1581683f6edd9a2983eebd0", exportPath: "./assets/clang-22.0.0-git20542-10.libcxx-pch.json" },
      { path: "/toolchains/clang-22.0.0-git20542-10.manifest.json", bytes: 744, sha256: "6382dcdfb6a2da49032a0e08da3b1fb490eb24432be85c3c12e3e871a5065273", exportPath: "./assets/clang-22.0.0-git20542-10.manifest.json" },
      { path: "/toolchains/clang-22.0.0-git20542-10.webc.gz.bin", bytes: 27000264, sha256: "7f10d90b8e52b270f04874641a1d0bf9e94e85b4f6c7573a774cebbc6d32552a", exportPath: "./assets/clang-22.0.0-git20542-10.webc.gz.bin" },
    ],
  }),
  descriptor({
    id: "go", version: "1.26.5", languages: ["go"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/go-1.26.5-wasip1.manifest.json", bytes: 67888, sha256: "5d784e9ca640b9525e84b598c0beb97ca110ae908568ca45f6441a441d99a262", exportPath: "./assets/go-1.26.5-wasip1.manifest.json" },
      { path: "/toolchains/go-1.26.5-wasip1.stdlib.gz.bin", bytes: 29300578, sha256: "aeffc384fdc624544f174ba5fc3c22395717fdbc3c4387d677d20855b6be80d8", exportPath: "./assets/go-1.26.5-wasip1.stdlib.gz.bin" },
      { path: "/toolchains/go-1.26.5-wasip1.webc.gz.bin", bytes: 12412445, sha256: "70a7e359884b09b2e1a622d6ac5cd6e31c334aab519e6dd80dff5e040a9e09e4", exportPath: "./assets/go-1.26.5-wasip1.webc.gz.bin" },
    ],
  }),
  descriptor({
    id: "java-teavm", version: "teavm-0.13.1-wasmgc-wasip1", languages: ["java"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/java-teavm-0.13.1.compile-classlib.bin", bytes: 1261778, sha256: "738a82b7d7e7ff8d98b07bb076785da7035847a166afb8446fd150c4efce6103", exportPath: "./assets/java-teavm-0.13.1.compile-classlib.bin" },
      { path: "/toolchains/java-teavm-0.13.1.runtime-classlib.bin", bytes: 23709664, sha256: "0ed234b66cdde19cb29e6c2865a3636d792d3cf72f102e73a7b3fdede80b79e6", exportPath: "./assets/java-teavm-0.13.1.runtime-classlib.bin" },
      { path: "/toolchains/java-teavm-0.13.1.compiler.wasm", bytes: 7854442, sha256: "8c37bce1c6fceeaffeffe93e10834309b67c8b6fb58c6f8a24547afe8be67f5d", exportPath: "./assets/java-teavm-0.13.1.compiler.wasm" },
    ],
  }),
  descriptor({
    id: "javascript", version: "typescript-7.0.2+quickjs-0.15.1", languages: ["javascript", "typescript"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/quickjs-0.15.1.wasm.gz.bin", bytes: 385018, sha256: "dc6e02e8610269e61b341331661515616451cec929fd534fa96d1c4f47fbcc9a", exportPath: "./assets/quickjs-0.15.1.wasm.gz.bin" },
      { path: "/toolchains/typescript-7.0.2.wasm.gz.bin", bytes: 7112878, sha256: "29c6ee0e46151e2644049ae96162b1b1d46dcb13310e2a928114bb9030c3ea92", exportPath: "./assets/typescript-7.0.2.wasm.gz.bin" },
    ],
  }),
  descriptor({
    id: "python", version: "3.14.7", languages: ["python"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/python-3.14.7-wasip1.manifest.json", bytes: 8385, sha256: "53a24b258363a8494af164121111a34b49c85fa0e054627fe131feba6f359cd5", exportPath: "./assets/python-3.14.7-wasip1.manifest.json" },
      { path: "/toolchains/python-3.14.7-wasip1.webc.gz.bin", bytes: 5205508, sha256: "10027f0e32c77dfa0ce1c413b6cb27307d6744fe5e18e6da8cea738bd020260c", exportPath: "./assets/python-3.14.7-wasip1.webc.gz.bin" },
    ],
  }),
  descriptor({
    id: "rust", version: "1.91.1-dev", languages: ["rust"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/rust-1.91.1-dev.manifest.json", bytes: 5974, sha256: "d5bbdca994e61888679c5738cb9420649c0854ed0eb5d65468bc67d5d550bce1", exportPath: "./assets/rust-1.91.1-dev.manifest.json" },
      { path: "/toolchains/rust-1.91.1-dev.webc.gz.bin", bytes: 74138827, sha256: "cfbdadc67be1315e735aa55bdf8a5a0d00171982a023fefcf7ba586127753887", exportPath: "./assets/rust-1.91.1-dev.webc.gz.bin" },
    ],
  }),
]);
