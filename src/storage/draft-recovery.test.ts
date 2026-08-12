import { describe, expect, it } from "vitest";
import { PROJECT_SOURCE_LIMITS } from "../core/project-files";
import type { Project } from "../core/types";
import {
  decodeDraftSourceExport,
  DRAFT_SOURCE_EXPORT_SCHEMA,
  encodeDraftSourceExport,
  restoreProjectSources,
} from "./draft-recovery";

function project(content = "console.log('current');\n"): Project {
  return {
    id: "collection:problem:javascript",
    name: "Current problem",
    files: [
      { path: "src/main.js", language: "javascript", content },
      { path: "src/helper.js", language: "javascript", content: "export const answer = 42;\n" },
    ],
    activeFile: "src/main.js",
    config: {
      language: "javascript",
      target: "wasip1",
      entry: "src/main.js",
      optimization: "release",
      args: ["private-argument"],
      stdin: "private stdin",
      env: { PRIVATE_VALUE: "not exported" },
      determinism: { randomSeed: 7, realtimeEpochMs: 0, clockStepNs: 1 },
      resources: {
        instructionBudget: 1,
        logicalTimeLimitMs: 1,
        memoryLimitBytes: 65_536,
        outputLimitBytes: 1,
        filesystemWriteLimitBytes: 1,
        filesystemEntryLimit: 1,
        wallTimeLimitMs: 1,
      },
    },
    updatedAt: 10,
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("source-only draft recovery", () => {
  it("roundtrips sources while excluding project identity and execution data", () => {
    const original = project();
    original.activeFile = "src/helper.js";
    original.config.entry = "src/helper.js";

    const encoded = encodeDraftSourceExport(original);
    const decoded = decodeDraftSourceExport(encoded);
    expect(decoded).toEqual({
      schema: DRAFT_SOURCE_EXPORT_SCHEMA,
      entry: "src/helper.js",
      activeFile: "src/helper.js",
      files: [
        { path: "src/helper.js", language: "javascript", content: "export const answer = 42;\n" },
        { path: "src/main.js", language: "javascript", content: "console.log('current');\n" },
      ],
    });
    expect(encoded).not.toContain(original.id);
    expect(encoded).not.toContain(original.name);
    expect(encoded).not.toContain("private stdin");
    expect(encoded).not.toContain("PRIVATE_VALUE");

    const restored = restoreProjectSources(project("overwritten\n"), encoded, 99);
    expect(restored).toMatchObject({
      id: "collection:problem:javascript",
      name: "Current problem",
      activeFile: "src/helper.js",
      updatedAt: 99,
      config: {
        entry: "src/helper.js",
        args: ["private-argument"],
        stdin: "private stdin",
        env: { PRIVATE_VALUE: "not exported" },
      },
      files: decoded.files,
    });
  });

  it("rejects malformed envelopes instead of recovering unknown fields", () => {
    const valid = JSON.parse(encodeDraftSourceExport(project())) as Record<string, unknown>;
    expect(() => decodeDraftSourceExport(serialized({ ...valid, legacyProject: {} })))
      .toThrow("must contain exactly");
    expect(() => decodeDraftSourceExport("not json"))
      .toThrow("valid UTF-8 JSON");
    expect(() => decodeDraftSourceExport(serialized({ ...valid, schema: "unsupported-source-draft/v0" })))
      .toThrow("schema must be");
  });

  it("rejects source content beyond the project byte limit", () => {
    const valid = JSON.parse(encodeDraftSourceExport(project())) as {
      schema: string;
      entry: string;
      activeFile: string;
      files: Array<{ path: string; language: string; content: string }>;
    };
    valid.files[0]!.content = "x".repeat(PROJECT_SOURCE_LIMITS.bytesPerFile + 1);

    expect(() => decodeDraftSourceExport(serialized(valid))).toThrow("byte source limit");
  });

  it.each(["../main.js", "/main.js", "src\\main.js", "src//main.js"])(
    "rejects unsafe source path %s",
    (path) => {
      const valid = JSON.parse(encodeDraftSourceExport(project())) as {
        schema: string;
        entry: string;
        activeFile: string;
        files: Array<{ path: string; language: string; content: string }>;
      };
      valid.entry = path;
      valid.activeFile = path;
      valid.files[0]!.path = path;
      expect(() => decodeDraftSourceExport(serialized(valid))).toThrow("normalized relative path");
    },
  );

  it("rejects a recovery artifact for a different workspace language", () => {
    const recovered = project();
    recovered.files[0]!.language = "python";
    recovered.config.language = "python";
    const encoded = encodeDraftSourceExport(recovered);

    expect(() => restoreProjectSources(project(), encoded)).toThrow("does not match this workspace language");
  });
});
