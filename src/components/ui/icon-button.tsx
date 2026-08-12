"use client";

import type { ButtonHTMLAttributes, ComponentType, SVGProps } from "react";
import { Tooltip } from "./tooltip";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { readonly size?: number | string }>;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  readonly label: string;
  readonly icon: Icon;
  readonly tooltip?: string;
  readonly tone?: "neutral" | "primary" | "danger";
  readonly size?: "sm" | "md";
  readonly pressed?: boolean;
}

export function IconButton({
  label,
  icon: Icon,
  tooltip = label,
  tone = "neutral",
  size = "md",
  pressed,
  className,
  type = "button",
  ...buttonProps
}: IconButtonProps) {
  const classes = ["ui-icon-button", `ui-icon-button-${tone}`, `ui-icon-button-${size}`, className].filter(Boolean).join(" ");
  return <Tooltip content={tooltip}>
    <button {...buttonProps} aria-label={label} aria-pressed={pressed} className={classes} type={type}>
      <Icon aria-hidden="true" size={size === "sm" ? 14 : 16} />
    </button>
  </Tooltip>;
}
