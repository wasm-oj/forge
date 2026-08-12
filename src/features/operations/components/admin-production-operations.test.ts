import { describe, expect, it } from "vitest";
import { parseAdminActivationRequest } from "./admin-production-operations";

describe("Admin production activation request boundary", () => {
  it("accepts only the exact activation request shape", () => {
    const value = {
      expectedCurrentReleaseId: null,
      manifest: { releaseId: "11111111-1111-4111-8111-111111111111" },
    };
    expect(parseAdminActivationRequest(value)).toEqual(value);
    expect(() => parseAdminActivationRequest({ ...value, token: "secret" })).toThrow("invalid shape");
    expect(() => parseAdminActivationRequest({ ...value, manifest: [] })).toThrow("manifest must be an object");
    expect(() => parseAdminActivationRequest({ ...value, expectedCurrentReleaseId: 1 })).toThrow("current-release fence");
  });
});
