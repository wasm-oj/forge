export const DEFAULT_BOTTOM_PANEL_HEIGHT = 360;
export const MIN_BOTTOM_PANEL_HEIGHT = 150;

const EDITOR_TABS_HEIGHT = 36;
const PANEL_RESIZER_HEIGHT = 7;
const MIN_EDITOR_HEIGHT = 210;

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
}

export function maximumBottomPanelHeight(stackHeight: number): number {
  const availableHeight = Math.floor(requireFinite(stackHeight, "stackHeight"))
    - EDITOR_TABS_HEIGHT
    - PANEL_RESIZER_HEIGHT
    - MIN_EDITOR_HEIGHT;
  return Math.max(MIN_BOTTOM_PANEL_HEIGHT, availableHeight);
}

export function clampBottomPanelHeight(stackHeight: number, requestedHeight: number): number {
  const height = Math.round(requireFinite(requestedHeight, "requestedHeight"));
  return Math.min(
    maximumBottomPanelHeight(stackHeight),
    Math.max(MIN_BOTTOM_PANEL_HEIGHT, height),
  );
}

export function resizedBottomPanelHeight(
  stackHeight: number,
  startHeight: number,
  startPointerY: number,
  currentPointerY: number,
): number {
  return clampBottomPanelHeight(
    stackHeight,
    requireFinite(startHeight, "startHeight")
      + requireFinite(startPointerY, "startPointerY")
      - requireFinite(currentPointerY, "currentPointerY"),
  );
}
