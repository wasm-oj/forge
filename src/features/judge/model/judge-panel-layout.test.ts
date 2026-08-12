import { describe, expect, it } from "vitest";
import {
  clampBottomPanelHeight,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  maximumBottomPanelHeight,
  MIN_BOTTOM_PANEL_HEIGHT,
  resizedBottomPanelHeight,
} from "./judge-panel-layout";

describe("judge panel layout", () => {
  it("reserves the editor tabs, resize handle, and minimum editor height", () => {
    expect(maximumBottomPanelHeight(1_000)).toBe(747);
  });

  it("clamps the panel between its minimum and the available workspace", () => {
    expect(clampBottomPanelHeight(1_000, 20)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
    expect(clampBottomPanelHeight(1_000, DEFAULT_BOTTOM_PANEL_HEIGHT)).toBe(360);
    expect(clampBottomPanelHeight(1_000, 900)).toBe(747);
  });

  it("makes the panel taller when the separator is dragged upward", () => {
    expect(resizedBottomPanelHeight(1_000, 360, 600, 520)).toBe(440);
    expect(resizedBottomPanelHeight(1_000, 360, 600, 680)).toBe(280);
  });

  it("preserves both panel minima in a short workspace", () => {
    expect(maximumBottomPanelHeight(350)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
    expect(resizedBottomPanelHeight(350, 360, 600, 400)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
  });

  it("rejects invalid dimensions instead of hiding layout defects", () => {
    expect(() => clampBottomPanelHeight(Number.NaN, 360)).toThrow(TypeError);
    expect(() => clampBottomPanelHeight(1_000, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
