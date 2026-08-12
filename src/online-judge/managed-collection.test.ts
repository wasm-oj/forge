import { describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "../core/canonical-json";
import {
  MANAGED_COLLECTION_SCHEMA,
  parseManagedCollectionContract,
  parseManagedCollectionV2,
} from "./managed-collection";

function contract() {
  return {
    schema: MANAGED_COLLECTION_SCHEMA,
    collectionRevision: "a".repeat(64),
    problems: [{
      slug: "sum-two",
      allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
      contestPublic: { repositoryPath: `managed/sum-two.${"b".repeat(64)}.contest.json`, bytes: 120, sha256: "b".repeat(64) },
      judgePackage: { repositoryPath: `managed/sum-two.${"c".repeat(64)}.wasmojjudge`, bytes: 4096, sha256: "c".repeat(64) },
    }],
  };
}

describe("managed collection v2 contract", () => {
  it("accepts only the generated digest-addressed publication shape", () => {
    const bytes = canonicalJsonBytes(contract());
    const parsed = parseManagedCollectionV2(bytes);
    expect(parsed.problems[0]).toEqual(contract().problems[0]);
    expect(parseManagedCollectionContract(contract())).toEqual(parsed);
  });

  it("rejects noncanonical bytes at the platform boundary", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(contract(), null, 2)}\n`);
    expect(() => parseManagedCollectionV2(bytes)).toThrow("WASM-OJ canonical JSON");
  });

  it("does not accept v1 or author-only managed-source documents", () => {
    expect(() => parseManagedCollectionContract({ ...contract(), schema: "unsupported-managed-collection/v1" })).toThrow("wasm-oj-platform/managed-collection/v2");
    expect(() => parseManagedCollectionContract({
      schema: "wasm-oj-platform/managed-collection-source/v1",
      problems: [],
    })).toThrow("must contain exactly");
  });

  it("rejects traversal and duplicate publication paths", () => {
    const traversed = structuredClone(contract());
    traversed.problems[0]!.judgePackage.repositoryPath = "../secret.wasmojjudge";
    expect(() => parseManagedCollectionContract(traversed)).toThrow("normalized relative POSIX path");

    const duplicated = structuredClone(contract());
    duplicated.problems[0]!.judgePackage.repositoryPath = duplicated.problems[0]!.contestPublic.repositoryPath;
    expect(() => parseManagedCollectionContract(duplicated)).toThrow("declared more than once");
  });

  it("rejects undeclared fields instead of guessing compatibility", () => {
    expect(() => parseManagedCollectionContract({
      ...contract(),
      problems: [{ ...contract().problems[0], references: [] }],
    })).toThrow("must contain exactly");
  });

  it("applies the 8 MiB public and 32 MiB judge publication limits independently", () => {
    const value = structuredClone(contract());
    value.problems[0]!.judgePackage.bytes = 9 * 1024 * 1024;
    expect(parseManagedCollectionContract(value).problems[0]!.judgePackage.bytes).toBe(9 * 1024 * 1024);
    value.problems[0]!.contestPublic.bytes = 8 * 1024 * 1024 + 1;
    expect(() => parseManagedCollectionContract(value)).toThrow("outside its publication limit");
  });
});
