"use client";

import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";

interface TooltipChildProps {
  readonly "aria-describedby"?: string;
}

export function Tooltip({ content, children, placement = "top" }: {
  readonly content: string;
  readonly children: ReactElement<TooltipChildProps>;
  readonly placement?: "top" | "right" | "bottom" | "left";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  function openAfterDelay() {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(true), 350);
  }

  function closeTooltip() {
    clearTimeout(hoverTimer.current);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setOpen(false);
  }

  return <span
    className="ui-tooltip-root"
    onBlurCapture={closeTooltip}
    onFocusCapture={() => setOpen(true)}
    onKeyDown={handleKeyDown}
    onMouseEnter={openAfterDelay}
    onMouseLeave={closeTooltip}
  >
    {cloneElement(children, { "aria-describedby": describedBy })}
    <span className={`ui-tooltip ui-tooltip-${placement}`} id={id} role="tooltip" data-open={open ? "true" : "false"}>{content}</span>
  </span>;
}
