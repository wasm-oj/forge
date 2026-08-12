import { describe, expect, it } from "vitest";
import { workflowInstanceNotFound } from "./workflow-instance-status";

describe("Cloudflare Workflow instance status", () => {
  it("recognizes only the exact missing-instance error", () => {
    expect(workflowInstanceNotFound(new Error("(instance.not_found) Instance not found"))).toBe(true);
    expect(workflowInstanceNotFound(new Error("(instance.not_found) status unavailable"))).toBe(false);
    expect(workflowInstanceNotFound(new Error("Instance not found"))).toBe(false);
    expect(workflowInstanceNotFound("(instance.not_found) Instance not found")).toBe(false);
  });
});
