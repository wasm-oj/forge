import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { unpackNpmPackage } from "./packed-package.mjs";

const run = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packed = await unpackNpmPackage(repositoryRoot, "forge-nodenext-consumer-");

try {
  const temporary = path.dirname(packed.packageRoot);
  const consumerRoot = path.join(temporary, "consumer");
  const packageParent = path.join(consumerRoot, "node_modules/@wasm-oj");
  const installedPackage = path.join(packageParent, "forge");
  await mkdir(packageParent, { recursive: true });
  await rename(packed.packageRoot, installedPackage);

  await writeFile(path.join(consumerRoot, "package.json"), `${JSON.stringify({
    name: "forge-nodenext-consumer",
    private: true,
    type: "module",
  }, null, 2)}\n`);
  await writeFile(path.join(consumerRoot, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      verbatimModuleSyntax: true,
      forceConsistentCasingInFileNames: true,
    },
    files: ["consumer.ts"],
  }, null, 2)}\n`);
  await writeFile(path.join(consumerRoot, "consumer.ts"), `
import {
  FORGE_CONTRACT_ID,
  FORGE_CONTRACT_VERSION,
  ForgeDependencyManager,
  ForgeCompilerRegistry,
  ForgeEngine,
  MemoryDependencyCache,
  costProfileId,
  createExtendedCostBaselineRegistry,
  createSdkProject,
  resolveArtifactCostBudget,
  type BuildArtifact,
  type BuildResult,
  type CompileInput,
  type CostBudget,
  type DependencyManifest,
  type ForgeCompiler,
  type ForgeRunner,
  type InteractiveRunConfig,
  type InteractiveRunResult,
  type JudgeExecutor,
  type PackageFileSystemRequest,
  type PreparedRunRequest,
  type Project,
  type RunConfig,
  type RunResult,
  type RuntimeDriver,
  type RuntimeResolver,
  type WasmArtifact,
  type WorkerProgress,
} from "@wasm-oj/forge";
import {
  Forge,
  BrowserForgeCompiler,
  BrowserForgeRunner,
  IndexedDbDependencyCache,
  registerToolchainCache,
  type BrowserForgeCompilerOptions,
  type BrowserForgeRunnerOptions,
  type ToolchainCacheRegistrationOptions,
} from "@wasm-oj/forge/browser";
import {
  ServerForgeCompiler,
  ServerForgeRunner,
  FileSystemDependencyCache,
  type ServerForgeCompilerOptions,
  type ServerForgeRunnerOptions,
} from "@wasm-oj/forge/server";

export interface VerifiedForgeSurface {
  compiler: ForgeCompiler;
  runner: ForgeRunner;
  input: CompileInput;
  customBudget: CostBudget;
  dependencyManifest: DependencyManifest;
  browserCompilerOptions: BrowserForgeCompilerOptions;
  browserRunnerOptions: BrowserForgeRunnerOptions;
  toolchainCacheOptions: ToolchainCacheRegistrationOptions;
  serverCompilerOptions: ServerForgeCompilerOptions;
  serverRunnerOptions: ServerForgeRunnerOptions;
}

export const forgeValues = [
  FORGE_CONTRACT_ID,
  FORGE_CONTRACT_VERSION,
  ForgeCompilerRegistry,
  ForgeEngine,
  ForgeDependencyManager,
  MemoryDependencyCache,
  Forge,
  BrowserForgeCompiler,
  BrowserForgeRunner,
  IndexedDbDependencyCache,
  registerToolchainCache,
  ServerForgeCompiler,
  ServerForgeRunner,
  FileSystemDependencyCache,
  costProfileId,
  createExtendedCostBaselineRegistry,
  resolveArtifactCostBudget,
] as const;

class ConsumerCompiler implements ForgeCompiler {
  cacheIdentity(project: Project): string {
    return ["consumer-compiler-1", project.config.target, project.config.optimization].join(":");
  }
  ready(): Promise<void> { return Promise.resolve(); }
  build(_project: Project, _cacheKey: string): Promise<BuildResult> {
    return Promise.resolve({ success: false, diagnostics: [], stdout: "", stderr: "", cacheHit: false });
  }
  onProgress(_listener: (progress: WorkerProgress) => void): () => void { return () => undefined; }
  clearToolchainCache(): Promise<void> { return Promise.resolve(); }
  cancel(): void {}
  restart(): void {}
  dispose(): void {}
}

class ConsumerRunner implements ForgeRunner {
  ready(): Promise<void> { return Promise.resolve(); }
  run(_artifact: BuildArtifact, _config: RunConfig): Promise<RunResult> {
    return Promise.reject(new Error("consumer stub"));
  }
  interact(
    _contestant: BuildArtifact,
    _interactor: BuildArtifact,
    _config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult> {
    return Promise.reject(new Error("consumer stub"));
  }
  onProgress(_listener: (progress: WorkerProgress) => void): () => void { return () => undefined; }
  onStream(_listener: (stream: "stdout" | "stderr", chunk: string) => void): () => void { return () => undefined; }
  clearRuntimeCache(): Promise<void> { return Promise.resolve(); }
  cancel(): void {}
  cancelAndWait(): Promise<void> { return Promise.resolve(); }
  restart(): void {}
  dispose(): void {}
}

const runtimeDriver: RuntimeDriver = {
  id: "consumer-runtime",
  supports: (_artifact: BuildArtifact): boolean => true,
  async prepare(
    _artifact: BuildArtifact,
    config: RunConfig,
    resolver: RuntimeResolver,
  ): Promise<PreparedRunRequest> {
    const fileSystemRequest: PackageFileSystemRequest = {
      packageSpecifier: "consumer/runtime@1",
      command: "run",
      args: [],
      cacheKey: "consumer-runtime-1",
      expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    await resolver.packageFileSystem(fileSystemRequest);
    return {
      wasm: await resolver.quickJs(),
      args: [...config.args],
      env: { ...config.env },
      stdin: new Uint8Array(),
      files: {},
      outputPaths: [],
      startupEntropyBytes: 0,
      cost: {
        rawInstructionBudget: config.resources.instructionBudget,
        netInstructionBudget: config.resources.instructionBudget,
        baselineCost: 0,
        profile: "consumer",
      },
      determinism: { ...config.determinism },
      resources: {
        instructionBudget: config.resources.instructionBudget,
        logicalTimeLimitMs: config.resources.logicalTimeLimitMs,
        memoryLimitBytes: config.resources.memoryLimitBytes,
        outputLimitBytes: config.resources.outputLimitBytes,
        filesystemWriteLimitBytes: config.resources.filesystemWriteLimitBytes,
        filesystemEntryLimit: config.resources.filesystemEntryLimit,
      },
    };
  },
};

const judgeExecutor: JudgeExecutor = {
  run: (_artifact, _caseSpec, _stdin) => Promise.reject(new Error("consumer stub")),
  interact: (_contestant, _caseSpec, _input) => Promise.reject(new Error("consumer stub")),
};

const dependencyManifest: DependencyManifest = {
  requirements: [{ ecosystem: "go", name: "example.com/module", requirement: "v1.0.0" }],
};
const dependencyManager = new ForgeDependencyManager(new MemoryDependencyCache());

const customCompiler = new ConsumerCompiler();
const compilerRegistry = new ForgeCompilerRegistry([{
  languages: ["zig"],
  compiler: customCompiler,
}]);
const customProject = createSdkProject({
  language: "zig",
  target: "wasip1",
  optimization: "release",
  entry: "src/main.zig",
  files: { "src/main.zig": "pub fn main() void {}" },
});
const customProfile = costProfileId(
  "zig",
  "wasip1",
  "release",
  "zig-0.13.0-sha256-deadbeef",
);
const customBaselines = createExtendedCostBaselineRegistry({ [customProfile]: 42 });
const customArtifact: WasmArtifact = {
  kind: "wasm",
  forgeContract: FORGE_CONTRACT_VERSION,
  id: "zig-artifact",
  projectId: customProject.id,
  cacheKey: compilerRegistry.cacheIdentity(customProject),
  name: "zig-program",
  language: "zig",
  target: "wasip1",
  optimization: "release",
  createdAt: 0,
  durationMs: 0,
  size: 8,
  toolchains: ["zig-0.13.0-sha256-deadbeef"],
  costProfile: customProfile,
  bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
};
const customBudget = resolveArtifactCostBudget(customArtifact, 1_000, customBaselines);

export const consumerImplementations = {
  compiler: customCompiler,
  compilerRegistry,
  runner: new ConsumerRunner(),
  runtimeDriver,
  judgeExecutor,
  dependencyManifest,
  dependencyManager,
  customProject,
  customArtifact,
  customBudget,
};
`);

  const typescript = path.join(repositoryRoot, "node_modules/typescript/lib/tsc.js");
  try {
    await run(process.execPath, [typescript, "--project", path.join(consumerRoot, "tsconfig.json"), "--pretty", "false"], {
      cwd: consumerRoot,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `Strict NodeNext consumer compilation from the packed npm tarball failed.${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`,
      { cause: error },
    );
  }
} finally {
  await packed.cleanup();
}

process.stdout.write("Strict NodeNext Forge consumer compilation from the packed npm tarball passed.\n");
