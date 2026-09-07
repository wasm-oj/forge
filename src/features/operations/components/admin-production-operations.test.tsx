import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProductionOperations, ContainerProbePanel } from "./admin-production-operations";

const product = vi.hoisted(() => ({
  session: { authenticated: true, user: { roles: ["admin"] } },
  sessionStatus: "ready",
}));

vi.mock("../../platform/components/app-shell", () => ({
  useProduct: () => ({ locale: "en", ...product }),
}));

describe("production operations", () => {
  beforeEach(() => {
    product.session = { authenticated: true, user: { roles: ["admin"] } };
    product.sessionStatus = "ready";
  });

  it("requires an authenticated Admin session before presenting operations", () => {
    product.session.user.roles = ["organizer"];
    const organizer = renderToStaticMarkup(createElement(AdminProductionOperations));
    expect(organizer).toContain("An Admin role is required.");
    expect(organizer).not.toContain("Check Container");

    product.session.user.roles = ["admin"];
    product.session.authenticated = false;
    expect(renderToStaticMarkup(createElement(AdminProductionOperations))).toContain("An Admin role is required.");
  });

  it("explains cutover Admin access and makes Container checking an explicit action", () => {
    const html = renderToStaticMarkup(createElement(AdminProductionOperations));
    expect(html).toContain("repository-source-truth-cutover");
    expect(html).toContain("existing Admin session permits catalog sync and code Official Submit");
    expect(html).toContain("other formal mutations remain paused");
    expect(html).toContain('href="/organizer/catalogs"');
    expect(html).toContain('href="/problems"');
    expect(html).toContain("Not checked");
    expect(html).toContain("Check Container</button>");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Arm in memory");
  });

  it("shows the verified build with technical details collapsed", () => {
    const buildId = "a".repeat(40);
    const html = renderToStaticMarkup(createElement(ContainerProbePanel, {
      result: { ready: true, buildId, contract: 2, protocol: "wasm-oj-container-v2", workerVersionId: "worker-version" },
      error: "", checking: false, disabled: false, onCheck: vi.fn(),
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Container is ready and matches the Worker.");
    expect(html).toContain(`<code>${buildId}</code>`);
    expect(html).toContain("<details><summary>Container details</summary>");
    expect(html).toContain("wasm-oj-container-v2");
  });

  it("presents a failed check as an alert and leaves the check action available", () => {
    const html = renderToStaticMarkup(createElement(ContainerProbePanel, {
      error: "Container build does not match the Worker build.", checking: false, disabled: false, onCheck: vi.fn(),
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Container build does not match the Worker build.");
    expect(html).toContain("Check Container</button>");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("Container is ready");
  });
});
