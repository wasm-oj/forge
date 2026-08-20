import { describe, expect, it, vi } from "vitest";
import { eraseAccount } from "./account-erasure";
import { activateProductionRelease, createOrganizerApplication, getFormalMutationControl, listOrganizerApplications, reviewOrganizerApplication } from "./admin";
import type { WasmOjWorkerEnv } from "./env";
import { beginGithubAppInstall, completeGithubAppInstall } from "./organizer";
import { rotateContestInviteCode, updateProfile } from "./product";
import { updateSubmissionVisibility } from "./submissions";

const ORIGIN = "https://wasm-oj.test";
const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";

function bearerRequest(pathname: string): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${"b".repeat(43)}`,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function bearerNavigation(pathname: string): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    headers: { authorization: `Bearer ${"b".repeat(43)}` },
  });
}

describe("browser-only privileged boundary", () => {
  it.each([
    ["Organizer application", () => createOrganizerApplication(bearerRequest("/api/organizer/applications"), environment())],
    ["Organizer application review", () => reviewOrganizerApplication(bearerRequest(`/api/admin/organizer-applications/${RESOURCE_ID}/review`), environment(), RESOURCE_ID)],
    ["production release activation", () => activateProductionRelease(bearerRequest("/api/admin/releases/activate"), environment())],
    ["profile update", () => updateProfile(bearerRequest("/api/profile"), environment())],
    ["submission visibility", () => updateSubmissionVisibility(bearerRequest(`/api/submissions/${RESOURCE_ID}/visibility`), environment(), RESOURCE_ID)],
    ["contest invite-code rotation", () => rotateContestInviteCode(bearerRequest(`/api/organizer/contests/${RESOURCE_ID}/invite-code`), environment(), RESOURCE_ID)],
    ["account erasure", () => eraseAccount(new Request(`${ORIGIN}/api/account`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${"b".repeat(43)}`, origin: ORIGIN },
    }), environment())],
    ["GitHub App installation start", () => beginGithubAppInstall(bearerNavigation("/api/organizer/github/install"), environment())],
    ["GitHub App installation callback", () => completeGithubAppInstall(bearerNavigation(`/api/organizer/github/callback?installation_id=1&state=${"s".repeat(43)}`), environment())],
    ["Organizer application administration", () => listOrganizerApplications(bearerNavigation("/api/admin/organizer-applications"), environment())],
    ["production formal-mutation status", () => getFormalMutationControl(bearerNavigation("/api/admin/formal-mutations"), environment())],
  ])("rejects CLI bearer credentials for %s", async (_label, invoke) => {
    await expect(invoke()).rejects.toMatchObject({
      status: 401,
      code: "browser-authentication-required",
    });
  });
});

function environment(): WasmOjWorkerEnv {
  return {
    PUBLIC_ORIGIN: ORIGIN,
    DB: { prepare: vi.fn(() => { throw new Error("Browser-only rejection must precede database access."); }) } as unknown as D1Database,
  } as WasmOjWorkerEnv;
}
