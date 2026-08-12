"use client";

import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

export type RemoteState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T; readonly refreshing?: boolean }
  | { readonly status: "error"; readonly message: string; readonly retry: () => void };

export function RemoteStateView<T>({
  state,
  loadingLabel,
  retryLabel,
  empty,
  isEmpty,
  children,
}: {
  readonly state: RemoteState<T>;
  readonly loadingLabel: string;
  readonly retryLabel: string;
  readonly empty: ReactNode;
  readonly isEmpty: (data: T) => boolean;
  readonly children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <div className="product-empty large" role="status" aria-live="polite"><span className="spinner" />{loadingLabel}</div>;
  if (state.status === "error") return <div className="product-error" role="alert"><span>{state.message}</span><button type="button" onClick={state.retry}><RotateCcw aria-hidden="true" size={15} />{retryLabel}</button></div>;
  if (isEmpty(state.data)) return <>{empty}</>;
  return <>{children(state.data)}{state.refreshing && <span className="sr-only" role="status">{loadingLabel}</span>}</>;
}
