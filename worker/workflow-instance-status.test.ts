import { describe, expect, it } from "vitest";
import { workflowInstanceNotFound, workflowStatusOrUnknown } from "./workflow-instance-status";

describe("Cloudflare Workflow instance status", () => {
  it("recognizes only the exact missing-instance error", () => {
    expect(workflowInstanceNotFound(new Error("(instance.not_found) Instance not found"))).toBe(true);
    expect(workflowInstanceNotFound(new Error("(instance.not_found) status unavailable"))).toBe(false);
    expect(workflowInstanceNotFound(new Error("Instance not found"))).toBe(false);
    expect(workflowInstanceNotFound("(instance.not_found) Instance not found")).toBe(false);
  });

  it("normalizes instance.not_found from either get or status", async () => {
    const missing = new Error("(instance.not_found) Instance not found");
    await expect(workflowStatusOrUnknown({
      get: async () => { throw missing; },
    }, "missing-at-get")).resolves.toEqual({ status: "unknown" });
    await expect(workflowStatusOrUnknown({
      get: async () => ({ status: async () => { throw missing; } }),
    }, "missing-at-status")).resolves.toEqual({ status: "unknown" });
  });

  it("preserves every other status error", async () => {
    const outage = new Error("workflow status unavailable");
    await expect(workflowStatusOrUnknown({
      get: async () => { throw outage; },
    }, "outage")).rejects.toBe(outage);
  });
});
