"use client";

import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";
import { problemText, type JudgeProblem } from "../../../judge/problem-model";
import { JudgeWorkspace, type ContestWorkspaceNavigation } from "./judge-workspace";
import { judgeUiText } from "../model/judge-ui-i18n";
import type { ContestWorkspaceRuntime } from "../model/contest-workspace-runtime";
import type { PromptAssistWorkspaceContext } from "../model/prompt-assist-contract";
import {
  isRevealedContestProblem,
  nextContestBoundaryDelayMs,
  nextContestWallBoundaryDelayMs,
  type ContestDetailResponse,
} from "../../contests/model/contest-projection";
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
  readonly contestRuntime?: ContestWorkspaceRuntime;
  readonly promptAssistContext?: PromptAssistWorkspaceContext;
}

type ManagedProblemLoadState =
  | { readonly key: string; readonly session: ManagedProblemSession }
  | { readonly key: string; readonly error: string };

export function ManagedProblemWorkspace({ problemId, contestId }: ManagedProblemContext) {
  const { locale: problemLocale, setLocale: changeLocale } = useProduct();
  const parsedContext = useMemo(() => {
    try {
      return { ok: true, context: normalizeManagedProblemContext({
        problemId,
        ...(contestId === undefined ? {} : { contestId }),
      }) } as const;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
    }
  }, [contestId, problemId]);
  const [loadState, setLoadState] = useState<ManagedProblemLoadState>();
  const [retry, setRetry] = useState(0);
  const text = judgeUiText(problemLocale);
  const loadKey = parsedContext.ok
    ? `${parsedContext.context.contestId ?? "practice"}:${parsedContext.context.problemId}:${retry}`
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
      let contestRuntime: ContestWorkspaceRuntime | undefined;
      let promptAssistContext: PromptAssistWorkspaceContext | undefined;
      if (parsedContext.context.contestId) {
        const response = await fetch(`/api/contests/${encodeURIComponent(parsedContext.context.contestId)}`, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Contest navigation failed with HTTP ${response.status}.`);
        const detail = await response.json() as ContestDetailResponse;
        const revealedProblems = detail.problems.filter(isRevealedContestProblem);
        const position = revealedProblems.findIndex((candidate) => candidate.problemId === parsedContext.context.problemId);
        if (position < 0) throw new Error("The active problem is absent from its contest.");
        const activeContestProblem = revealedProblems[position]!;
        if (activeContestProblem.contentCommit !== collection.source.catalogCommit) {
          throw new Error("The contest and managed-content commits disagree.");
        }
        if (activeContestProblem.promptContextSha256 && collection.source.promptContextSha256
          && activeContestProblem.promptContextSha256 !== collection.source.promptContextSha256) {
          throw new Error("The contest and managed-content prompt context identities disagree.");
        }
        if (detail.contest.aiAssistAvailable !== collection.source.aiAssistAvailable
          || (activeContestProblem.assistContextSha256 ?? null) !== collection.source.assistContextSha256) {
          throw new Error("The contest and managed-content Prompt Assist availability disagrees.");
        }
        const sourceAdmission = collection.source.contestAdmission;
        const contestAdmission = activeContestProblem.contestAdmission;
        if (!sourceAdmission
          || sourceAdmission.timelineGeneration !== contestAdmission.timelineGeneration
          || sourceAdmission.ruleEpoch !== contestAdmission.ruleEpoch
          || sourceAdmission.problemEpoch !== contestAdmission.problemEpoch) {
          throw new Error("The contest and managed-content admission epochs disagree.");
        }
        const link = (index: number) => {
          const candidate = revealedProblems[index];
          return candidate ? {
            href: managedProblemWorkspacePath({ contestId: detail.contest.id, problemId: candidate.problemId }),
            label: candidate.title[problemLocale] ?? candidate.title.en ?? candidate.problemSlug,
          } : undefined;
        };
        contestNavigation = {
          title: detail.contest.title,
          overviewHref: `/contests/${encodeURIComponent(detail.contest.id)}`,
          previous: link(position - 1),
          next: link(position + 1),
        };
        contestRuntime = {
          contestId: detail.contest.id,
          problemId: activeContestProblem.problemId,
          timelineGeneration: contestAdmission.timelineGeneration,
          rulesEpoch: contestAdmission.ruleEpoch,
          problemEpoch: contestAdmission.problemEpoch,
          officialTrack: detail.contest.officialTrack,
          promptCompilerAvailable: detail.contest.promptCompilerAvailable,
          aiAssistAvailable: detail.contest.aiAssistAvailable,
          promptContextSha256: activeContestProblem.promptContextSha256
            ?? collection.source.promptContextSha256
            ?? null,
          availability: activeContestProblem.availability,
          attemptsRemaining: activeContestProblem.attemptsRemaining,
          paused: detail.contest.paused,
          phase: detail.contest.phase,
          runtimeState: detail.contest.runtimeState,
          clock: detail.contest.clock,
          scheduleShiftSeconds: detail.contest.scheduleShiftSeconds,
          logicalTimeSeconds: detail.contest.logicalTimeSeconds,
          nextBoundarySeconds: detail.contest.nextBoundarySeconds,
          fetchedAtMs: Date.now(),
          judgeProvisional: detail.contest.judgeProvisional,
          entrantState: detail.contest.entrant?.state ?? null,
          publicRepositoryWarning: detail.contest.publicRepositoryTimingWarning?.message ?? null,
        };
        const assistActionable = collection.source.aiAssistAvailable
          && detail.contest.runtimeState === "running"
          && !detail.contest.paused
          && detail.contest.entrant?.state === "active"
          && activeContestProblem.availability === "open";
        if (assistActionable) {
          if (!collection.source.assistContextSha256) throw new Error("Prompt Assist public context is unavailable.");
          promptAssistContext = {
            kind: "contest",
            contestId: detail.contest.id,
            problemId: activeContestProblem.problemId,
            contentCommit: collection.source.catalogCommit,
            timelineGeneration: contestAdmission.timelineGeneration,
            ruleEpoch: contestAdmission.ruleEpoch,
            problemEpoch: contestAdmission.problemEpoch,
            publicContextSha256: collection.source.assistContextSha256,
          };
        }
      } else if (collection.source.aiAssistAvailable) {
        if (!collection.source.assistContextSha256) throw new Error("Prompt Assist public context is unavailable.");
        promptAssistContext = {
          kind: "practice",
          problemId: collection.source.problemId,
          catalogCommit: collection.source.catalogCommit,
          publicContextSha256: collection.source.assistContextSha256,
        };
      }
      if (!controller.signal.aborted) setLoadState({ key: loadKey, session: {
        collection, problem, contestNavigation, contestRuntime, promptAssistContext,
      } });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState({ key: loadKey, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [loadKey, parsedContext, problemLocale]);

  const currentLoadState = loadState?.key === loadKey ? loadState : undefined;
  const activeRuntime = currentLoadState && "session" in currentLoadState
    ? currentLoadState.session.contestRuntime
    : undefined;
  useEffect(() => {
    if (!activeRuntime) return;
    const logicalDelay = nextContestBoundaryDelayMs(activeRuntime, activeRuntime.fetchedAtMs, Date.now());
    const wallDelay = nextContestWallBoundaryDelayMs(activeRuntime, Date.now());
    const delays = [logicalDelay, wallDelay].filter((value): value is number => value !== undefined);
    const delay = delays.length === 0 ? undefined : Math.min(...delays);
    if (delay === undefined) return;
    const timeout = window.setTimeout(() => setRetry((value) => value + 1), Math.max(250, delay + 100));
    return () => window.clearTimeout(timeout);
  }, [activeRuntime]);
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
      contestRuntime={currentLoadState.session.contestRuntime}
      promptAssistContext={currentLoadState.session.promptAssistContext}
    />
  );
}
