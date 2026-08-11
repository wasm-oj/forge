import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search, Trash2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Drawer } from "./drawer";
import { FilterField } from "./filter-field";
import { IconButton } from "./icon-button";
import { RemoteStateView } from "./remote-state";

describe("shared product UI primitives", () => {
  it("keeps an icon-only action named and discoverable", () => {
    const html = renderToStaticMarkup(createElement(IconButton, { icon: Trash2, label: "Delete account", onClick: vi.fn() }));
    expect(html).toContain('aria-label="Delete account"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("Delete account");
  });

  it("renders distinct loading and retryable error states", () => {
    // eslint-disable-next-line react/no-children-prop
    const loading = renderToStaticMarkup(createElement(RemoteStateView, { state: { status: "loading" }, loadingLabel: "Loading profile…", retryLabel: "Retry", empty: "Empty", isEmpty: () => false, children: () => "Ready" }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading profile…");
    expect(loading).not.toContain("Empty");

    // eslint-disable-next-line react/no-children-prop
    const error = renderToStaticMarkup(createElement(RemoteStateView, { state: { status: "error", message: "Network unavailable", retry: vi.fn() }, loadingLabel: "Loading profile…", retryLabel: "Retry", empty: "Empty", isEmpty: () => false, children: () => "Ready" }));
    expect(error).toContain('role="alert"');
    expect(error).toContain("Network unavailable");
    expect(error).toContain("Retry");
  });

  it("keeps filter purpose visible and associated with its control", () => {
    // eslint-disable-next-line react/no-children-prop
    const html = renderToStaticMarkup(createElement(FilterField, { icon: createElement(Search, { "aria-hidden": true }), label: "Search", children: createElement("input", { name: "query" }) }));
    expect(html).toContain("Search");
    expect(html).toContain('name="query"');
    expect(html).toContain("ui-filter-control");
  });

  it("only exposes an open drawer as a modal dialog", () => {
    const returnFocusRef = createRef<HTMLButtonElement>();
    // eslint-disable-next-line react/no-children-prop
    const closed = renderToStaticMarkup(createElement(Drawer, { open: false, label: "Account deletion", onClose: vi.fn(), returnFocusRef, children: "Content" }));
    expect(closed).toBe("");

    // eslint-disable-next-line react/no-children-prop
    const open = renderToStaticMarkup(createElement(Drawer, { open: true, label: "Account deletion", onClose: vi.fn(), returnFocusRef, children: "Content" }));
    expect(open).toContain('role="dialog"');
    expect(open).toContain('aria-modal="true"');
    expect(open).toContain("Account deletion");
  });
});
