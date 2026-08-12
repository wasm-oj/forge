"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function Drawer({
  open,
  label,
  onClose,
  returnFocusRef,
  initialFocusRef,
  portalTarget,
  side = "right",
  className,
  children,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly portalTarget?: Element;
  readonly side?: "left" | "right";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusReturnTarget = returnFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    const backgrounds = [...document.querySelectorAll<HTMLElement>("[data-drawer-background]")]
      .filter((element) => !element.contains(panel));
    const previousInert = backgrounds.map((element) => element.inert);
    backgrounds.forEach((element) => { element.inert = true; });
    document.body.style.overflow = "hidden";
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (initialFocusRef?.current ?? focusable[0] ?? panel).focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const current = [...panel!.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (current.length === 0) {
        event.preventDefault();
        panel!.focus();
        return;
      }
      const first = current[0]!;
      const last = current.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      backgrounds.forEach((element, index) => { element.inert = previousInert[index] ?? false; });
      focusReturnTarget?.focus();
    };
  }, [initialFocusRef, open, returnFocusRef]);

  if (!open) return null;
  const drawer = <div className={`ui-drawer-backdrop ui-drawer-${side}`}>
    <button className="ui-drawer-scrim" type="button" aria-hidden="true" onClick={onClose} tabIndex={-1} />
    <aside
      aria-labelledby={labelId}
      aria-modal="true"
      className={["ui-drawer", className].filter(Boolean).join(" ")}
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      <span className="sr-only" id={labelId}>{label}</span>
      {children}
    </aside>
  </div>;
  return typeof document === "undefined" ? drawer : createPortal(drawer, portalTarget ?? document.body);
}
