import { describe, expect, it } from "vitest";
import { assertExpectedContainerIdentity, type ContainerIdentity } from "../container/identity.mjs";

const identityValue = {
  schema: "wasm-oj-platform/container-identity/v3",
  contract: 2,
  protocol: "wasm-oj-container-v2",
  buildId: "a".repeat(40),
};
Object.defineProperty(identityValue, "verifiedDistribution", { enumerable: false, value: {} });
const identity = identityValue as unknown as ContainerIdentity;

describe("thin container identity", () => {
  it("contains only runtime coordinates in its public JSON shape", () => {
    expect(JSON.parse(JSON.stringify(identity))).toEqual({
      schema: "wasm-oj-platform/container-identity/v3",
      contract: 2,
      protocol: "wasm-oj-container-v2",
      buildId: "a".repeat(40),
    });
  });

  it("fences execution by the exact Git build ID", () => {
    expect(() => assertExpectedContainerIdentity({ expectedBuildId: "a".repeat(40) }, identity)).not.toThrow();
    expect(() => assertExpectedContainerIdentity({ expectedBuildId: "b".repeat(40) }, identity)).toThrow("expected build");
  });
});
