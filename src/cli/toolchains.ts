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
      { path: "/toolchains/clang-22.0.0-git20542-10.cc1-pins.json", bytes: 7457, sha256: "66c4604dccd3f89d8e1472bf4432367d7396cce4a01279b1a1db445f229dba72", exportPath: "./assets/clang-22.0.0-git20542-10.cc1-pins.json" },
      { path: "/toolchains/clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin", bytes: 13871086, sha256: "a4152027d248412eca8aec3e7e23f6f7c81f95170cae9fd385bcf02e57e91fc9", exportPath: "./assets/clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin" },
      { path: "/toolchains/clang-22.0.0-git20542-10.cpp-release.pch.gz.bin", bytes: 13870913, sha256: "18f4ca8ab8ca7888db572ba34146fc1acb213a7e7305000ea6285188f52f99f4", exportPath: "./assets/clang-22.0.0-git20542-10.cpp-release.pch.gz.bin" },
      { path: "/toolchains/clang-22.0.0-git20542-10.libcxx-pch.json", bytes: 1987, sha256: "d126c99e951a7302d4ea2b66da4ed64d3d74e9d319d562518867c8d8c97a06b8", exportPath: "./assets/clang-22.0.0-git20542-10.libcxx-pch.json" },
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
    id: "java-teavm", version: "teavm-0.13.1-wasi", languages: ["java"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/java-teavm-0.13.1.compile-classlib.bin", bytes: 1198350, sha256: "acfe3fb09e5f2c0c7c8dc2339c66fcdadc1f8e1bf1c74be446926175ef770868", exportPath: "./assets/java-teavm-0.13.1.compile-classlib.bin" },
      { path: "/toolchains/java-teavm-0.13.1.runtime-classlib.bin", bytes: 8798302, sha256: "21a9394586e416af2fca4eb0ed08521cbc8924e1d1afaa07863a59a3cfae54ab", exportPath: "./assets/java-teavm-0.13.1.runtime-classlib.bin" },
      { path: "/toolchains/java-teavm-0.13.1.wasi.compiler.webc.gz.bin", bytes: 6059335, sha256: "129f1f51d591e58954f88787d36396b856a9a68ba3ae9c9d14f20bd67c2c7722", exportPath: "./assets/java-teavm-0.13.1.wasi.compiler.webc.gz.bin" },
    ],
  }),
  descriptor({
    id: "javascript", version: "typescript-7.0.2+quickjs-0.15.1", languages: ["javascript", "typescript"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/quickjs-0.15.1.wasm.gz.bin", bytes: 384057, sha256: "8c7f0588210490e7d77f198fc91f72c1b94787ab4c359c4786ca59a363c4f5e8", exportPath: "./assets/quickjs-0.15.1.wasm.gz.bin" },
      { path: "/toolchains/typescript-7.0.2.wasm.gz.bin", bytes: 7113466, sha256: "06e58ce887d95d1895055699b8dc96a1cde7d1f2baa48de40f9b790e3271dc16", exportPath: "./assets/typescript-7.0.2.wasm.gz.bin" },
    ],
  }),
  descriptor({
    id: "python", version: "3.14.6", languages: ["python"], targets: ["wasip1"],
    assets: [
      { path: "/toolchains/python-3.14.6-wasip1.manifest.json", bytes: 8257, sha256: "054eccad04a7cee7ba1661062142ef0d639976850981eab8fc785f48eb26129e", exportPath: "./assets/python-3.14.6-wasip1.manifest.json" },
      { path: "/toolchains/python-3.14.6-wasip1.webc.gz.bin", bytes: 5188678, sha256: "218cd20ac4abb443e0700816010a615a345a43eae623a0232da2227135a6c7a6", exportPath: "./assets/python-3.14.6-wasip1.webc.gz.bin" },
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
