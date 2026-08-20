import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";

vi.mock("../../platform/components/app-shell", () => ({
  useProduct: () => ({
    locale: "zh-TW",
    refreshSession: async () => undefined,
    session: undefined,
    sessionStatus: "loading",
  }),
}));

vi.mock("../model/education-model", async () => {
  const actual = await vi.importActual<typeof import("../model/education-model")>("../model/education-model");
  return {
    ...actual,
    useCatalog: () => ({ collections: [], error: "", loading: false }),
  };
});

import { ProfileSettings } from "../../profiles/components/profile-settings";
import { CatalogEmptyState, ProblemCatalog } from "./problem-catalog";

test("problem catalog search uses only the toolbar FilterField layout", () => {
  const html = renderToStaticMarkup(createElement(ProblemCatalog));

  assert.match(html, /class="ui-filter-field catalog-toolbar-search"/u);
  assert.doesNotMatch(html, /class="[^"]*\bcatalog-search\b/u);
  assert.match(html, /class="ui-filter-control"[^>]*><svg[\s\S]*?<input aria-label="搜尋"/u);
});

test("catalog toolbar search modifier only controls responsive grid placement", () => {
  const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/\.catalog-toolbar > \.catalog-toolbar-search\s*\{([^}]*)\}/gu)]
    .map((match) => match[1].trim());

  assert.deepEqual(rules, ["grid-column: 1 / -1;", "grid-column: auto;"]);
});

test("filtered empty catalog offers one action that clears every filter", () => {
  const clear = vi.fn();
  const filtered = renderToStaticMarkup(createElement(CatalogEmptyState, {
    message: "No problems match these filters.",
    clearLabel: "Clear all filters",
    filtered: true,
    onClear: clear,
  }));
  const unfiltered = renderToStaticMarkup(createElement(CatalogEmptyState, {
    message: "No problems have been published.",
    clearLabel: "Clear all filters",
    filtered: false,
    onClear: clear,
  }));

  assert.match(filtered, /<button[^>]*>.*Clear all filters<\/button>/u);
  assert.doesNotMatch(unfiltered, /<button/u);
});

test("profile settings uses the standard product page width", () => {
  const html = renderToStaticMarkup(createElement(ProfileSettings));
  const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");

  assert.match(html, /<main class="product-page" id="main-content">/u);
  assert.match(html, /<div class="profile-settings-content">/u);
  assert.doesNotMatch(html, /\bnarrow-page\b/u);
  assert.match(css, /\.profile-settings-content\s*\{\s*max-width:\s*760px;\s*\}/u);
});
