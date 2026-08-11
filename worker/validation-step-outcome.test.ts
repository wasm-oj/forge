import { describe, expect, it, vi } from "vitest";
import { validationStepOutcome } from "./validation-step-outcome";

describe("validation Container Workflow step outcome", () => {
  it.each([409, 422] as const)("keeps HTTP %s rejection classification across serialization", async (status) => {
    const code = status === 422 ? "validation-input-rejected" : "container-one-shot";
    const outcome = await validationStepOutcome(
      new Response(JSON.stringify({ error: { code } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
      vi.fn(),
    );

    expect(JSON.parse(JSON.stringify(outcome))).toMatchObject({ kind: "rejected", status, code });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("Expected a validation rejection.");
    expect(outcome.message).not.toContain("undefined");
  });

  it("preserves only a bounded, known safe rejection code and message", async () => {
    const safe = await validationStepOutcome(
      new Response(JSON.stringify({
        error: {
          code: "container-identity-mismatch",
          message: "Judge Container identity could not be verified.",
        },
      }), { status: 409 }),
      vi.fn(),
    );
    expect(safe).toEqual({
      kind: "rejected",
      status: 409,
      code: "container-identity-mismatch",
      message: "Judge Container identity could not be verified.",
    });

    const untrusted = await validationStepOutcome(
      new Response(JSON.stringify({ error: { code: "private-path-leak", message: "secret/repository/path" } }), { status: 422 }),
      vi.fn(),
    );
    expect(untrusted).toEqual({
      kind: "rejected",
      status: 422,
      code: "validation-failed",
      message: "Managed collection validation rejected the canonical source.",
    });
  });

  it("keeps successful parsing and infrastructure failures distinct", async () => {
    const acceptedReader = vi.fn(async () => ({ problems: 45 }));
    await expect(validationStepOutcome(new Response("{}"), acceptedReader)).resolves.toEqual({
      kind: "accepted",
      result: { problems: 45 },
    });
    expect(acceptedReader).toHaveBeenCalledOnce();

    await expect(validationStepOutcome(new Response("upstream failed", { status: 503 }), acceptedReader))
      .rejects.toThrow("infrastructure failed with HTTP 503");
    expect(acceptedReader).toHaveBeenCalledOnce();
  });
});
