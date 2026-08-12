"use client";

import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";
import { problemText, type JudgeProblem } from "../../../judge/problem-model";
import { JudgeWorkspace, type ContestWorkspaceNavigation } from "./judge-workspace";
import { judgeUiText } from "../model/judge-ui-i18n";
import {
  loadManagedProblemCollection,
  managedProblemWorkspacePath,
  normalizeManagedProblemContext,
  type LoadedManagedProblemCollection,
  type ManagedProblemContext,
} from "../../../online-judge/managed-problem-collection";

interface ManagedProblemSession {
  readonly collection: LoadedManagedProblemCollection;
  readonly problem: JudgeProblem;
  readonly contestNavigation?: ContestWorkspaceNavigation;
}

interface ContestWorkspaceDetail {
  readonly contest: { readonly id: string; readonly title: string };
  readonly problems: readonly {
    readonly problemVersionId: string;
    readonly problemSlug: string;
    readonly title: Record<string, string>;
  }[];
}

type ManagedProblemLoadState =
  | { readonly key: string; readonly session: ManagedProblemSession }
  | { readonly key: string; readonly error: string };

export function ManagedProblemWorkspace({ problemVersionId, contestId }: ManagedProblemContext) {
  const { locale: problemLocale, setLocale: changeLocale } = useProduct();
  const parsedContext = useMemo(() => {
    try {
      return { ok: true, context: normalizeManagedProblemContext({
        problemVersionId,
        ...(contestId === undefined ? {} : { contestId }),
      }) } as const;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
    }
  }, [contestId, problemVersionId]);
  const [loadState, setLoadState] = useState<ManagedProblemLoadState>();
  const [retry, setRetry] = useState(0);
  const text = judgeUiText(problemLocale);
  const loadKey = parsedContext.ok
    ? `${parsedContext.context.contestId ?? "practice"}:${parsedContext.context.problemVersionId}:${retry}`
    : `invalid:${retry}`;

  useEffect(() => {
    if (!parsedContext.ok) return;
    const controller = new AbortController();
    void (async () => {
      const collection = await loadManagedProblemCollection(parsedContext.context, { signal: controller.signal });
      const entry = collection.index.problems[0];
      if (!entry) throw new Error("The exact-commit managed problem content is empty.");
      const problem = await collection.loadProblem(entry.id, controller.signal);
      let contestNavigation: ContestWorkspaceNavigation | undefined;
      if (parsedContext.context.contestId) {
        const response = await fetch(`/api/contests/${encodeURIComponent(parsedContext.context.contestId)}`, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Contest navigation failed with HTTP ${response.status}.`);
        const detail = await response.json() as ContestWorkspaceDetail;
        const position = detail.problems.findIndex((candidate) => candidate.problemVersionId === parsedContext.context.problemVersionId);
        if (position < 0) throw new Error("The active problem is absent from its contest.");
        const link = (index: number) => {
          const candidate = detail.problems[index];
          return candidate ? {
            href: managedProblemWorkspacePath({ contestId: detail.contest.id, problemVersionId: candidate.problemVersionId }),
            label: candidate.title[problemLocale] ?? candidate.title.en ?? candidate.problemSlug,
          } : undefined;
        };
        contestNavigation = {
          title: detail.contest.title,
          overviewHref: `/contests/${encodeURIComponent(detail.contest.id)}`,
          previous: link(position - 1),
          next: link(position + 1),
        };
      }
      if (!controller.signal.aborted) setLoadState({ key: loadKey, session: { collection, problem, contestNavigation } });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState({ key: loadKey, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [loadKey, parsedContext, problemLocale]);

  const currentLoadState = loadState?.key === loadKey ? loadState : undefined;
  usePageTitle(currentLoadState && "session" in currentLoadState
    ? problemText(currentLoadState.session.problem, problemLocale).title
    : (problemLocale === "zh-TW" ? "解題工作區" : "Problem workspace"));
  const error = !parsedContext.ok
    ? parsedContext.error
    : currentLoadState && "error" in currentLoadState ? currentLoadState.error : undefined;
  if (error) {
    return (
      <main className="problem-catalog-status problem-source-recovery" role="alert">
        <TriangleAlert size={22} />
        <strong>{text.loader.failed}</strong>
        <span>{error}</span>
        {parsedContext.ok && <button type="button" className="problem-source-retry" onClick={() => {
          setLoadState(undefined);
          setRetry((value) => value + 1);
        }}>{text.loader.retry}</button>}
      </main>
    );
  }
  if (!currentLoadState || !("session" in currentLoadState) || !parsedContext.ok) {
    return <main className="problem-catalog-status" aria-live="polite"><ShieldCheck size={22} /><span>{text.loader.loading}</span></main>;
  }

  return (
    <JudgeWorkspace
      key={currentLoadState.session.collection.sourceKey}
      collection={currentLoadState.session.collection}
      initialProblem={currentLoadState.session.problem}
      problemLocale={problemLocale}
      onProblemLocaleChange={changeLocale}
      managedContext={parsedContext.context}
      contestNavigation={currentLoadState.session.contestNavigation}
    />
  );
}
