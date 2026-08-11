"use client";

import { useEffect } from "react";

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title === "Forge" ? title : `${title} · Forge`;
  }, [title]);
}
