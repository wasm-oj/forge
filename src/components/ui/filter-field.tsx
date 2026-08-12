"use client";

import type { ReactElement, ReactNode } from "react";

export function FilterField({ label, icon, children, className }: {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly children: ReactElement;
  readonly className?: string;
}) {
  return <label className={["ui-filter-field", className].filter(Boolean).join(" ")}>
    <span className="ui-filter-label">{label}</span>
    <span className="ui-filter-control">{icon}{children}</span>
  </label>;
}
