import { describe, expect, it } from "vitest";
import { isSubmissionProjectionAdmitted } from "../container/submission-result.mjs";

const PUBLISHED_RELEASE = "3dd39984-36df-43b2-b074-c0e174ebcd4a";
const ACTIVE_RELEASE = "5c687ae2-9747-492b-9690-8a58323aa6e5";
const BUNDLE_DIGEST = "7".repeat(64);

describe("published judge projection admission", () => {
  it("admits an immutable projection validated by an older release", () => {
    const projection = { forgeReleaseId: PUBLISHED_RELEASE, digest: BUNDLE_DIGEST };

    expect(PUBLISHED_RELEASE).not.toBe(ACTIVE_RELEASE);
    expect(isSubmissionProjectionAdmitted(projection, BUNDLE_DIGEST)).toBe(true);
  });

  it("rejects a projection whose bundle digest differs from the admission", () => {
    const projection = { forgeReleaseId: PUBLISHED_RELEASE, digest: BUNDLE_DIGEST };

    expect(isSubmissionProjectionAdmitted(projection, "8".repeat(64))).toBe(false);
  });

  it("requires a valid validation provenance release ID", () => {
    expect(isSubmissionProjectionAdmitted({ forgeReleaseId: "unknown", digest: BUNDLE_DIGEST }, BUNDLE_DIGEST)).toBe(false);
  });
});
