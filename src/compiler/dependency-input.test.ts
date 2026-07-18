import { describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash";
import { createDependencyLock } from "../dependencies/lock";
import { createDependencyBuildBundle, dependencyFileTreeSha256 } from "../dependencies/build";
import type { LockedDependencyPackage } from "../dependencies/types";
import { createSdkProject } from "../sdk/project";
import { goDependencyInput, rustDependencyInput } from "./dependency-input";
import { reachableGoDependencies } from "./go-toolchain";

const encoder = new TextEncoder();

describe("compiler dependency inputs", () => {
  it("creates topological rustc crate descriptors and root externs", async () => {
    const dep = await record("cargo", "dep", "1.0.0", new Uint8Array([1]));
    const root = { ...await record("cargo", "root", "1.0.0", new Uint8Array([2])), dependencies: [dep.id] };
    const lock = createDependencyLock("0".repeat(64), [root.id], [dep, root]);
    const bundle = await createDependencyBuildBundle(lock, new Map([
      [dep.id, new Uint8Array([1])],
      [root.id, new Uint8Array([2])],
    ]), [{
      ecosystem: "cargo",
      async materialize(item) {
        return item.id === dep.id
          ? { "Cargo.toml": encoder.encode('[package]\nname="dep"\nedition="2021"\n'), "src/lib.rs": encoder.encode("pub const VALUE: i32 = 42;\n") }
          : { "Cargo.toml": encoder.encode('[package]\nname="root"\nedition="2021"\n[dependencies]\ndep="1"\n'), "src/lib.rs": encoder.encode("pub use dep::VALUE;\n") };
      },
    }]);
    const project = createSdkProject({
      language: "rust",
      entry: "main.rs",
      files: { "main.rs": "fn main() { println!(\"{}\", root::VALUE); }" },
      dependencies: bundle,
    });

    const input = rustDependencyInput(project);
    expect(input.crates.map((item) => item.crateName)).toEqual(["dep", "root"]);
    expect(input.crates[1]?.externs).toEqual([{ crateName: "dep", path: input.crates[0]?.outputPath }]);
    expect(input.roots).toEqual([{ crateName: "root", path: input.crates[1]?.outputPath }]);
  });

  it("selects only Go packages reachable from submission imports", async () => {
    const item = await record("go", "example.com/mod", "v1.0.0", new Uint8Array([3]));
    const lock = createDependencyLock("1".repeat(64), [item.id], [item]);
    const files = {
      "go.mod": encoder.encode("module example.com/mod\n"),
      "answer/answer.go": encoder.encode("package answer\nimport \"fmt\"\nfunc Value() string { return fmt.Sprint(42) }\n"),
      "unused/unused.go": encoder.encode("package unused\nconst Value = 0\n"),
    };
    const bundle = {
      lock,
      lockSha256: await sha256Hex(JSON.stringify(lock)),
      packages: [{ package: item, filesSha256: await dependencyFileTreeSha256(files), files }],
    };
    const project = createSdkProject({
      language: "go",
      entry: "main.go",
      files: { "main.go": 'package main\nimport "example.com/mod/answer"\nfunc main() { _ = answer.Value() }\n' },
      dependencies: bundle,
    });
    const input = goDependencyInput(project);
    const reachable = reachableGoDependencies(project.files, input.packages, [{ importPath: "fmt" }]);

    expect(reachable.map((dependency) => dependency.importPath)).toEqual(["example.com/mod/answer"]);
  });
});

async function record(
  ecosystem: LockedDependencyPackage["ecosystem"],
  name: string,
  version: string,
  payload: Uint8Array,
): Promise<LockedDependencyPackage> {
  return {
    id: `${ecosystem}:${name}@${version}`,
    ecosystem,
    name,
    version,
    source: "https://packages.example/archive",
    integritySha256: await sha256Hex(payload),
    dependencies: [],
  };
}
