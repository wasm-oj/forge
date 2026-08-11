"use client";

import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { JudgeStudio } from "./judge-studio";
import {
  DEFAULT_JUDGE_UI_LOCALE,
  judgeUiText,
  readJudgeUiLocale,
  writeJudgeUiLocale,
} from "./judge-ui-i18n";
import type { JudgeProblem, ProblemLocale } from "../judge/problem-model";
import {
  loadManagedProblemCollection,
  normalizeManagedProblemContext,
  type LoadedManagedProblemCollection,
  type ManagedProblemContext,
} from "../online-judge/managed-problem-collection";

interface ManagedProblemSession {
  readonly collection: LoadedManagedProblemCollection;
  readonly problem: JudgeProblem;
}

type ManagedProblemLoadState =
  | { readonly key: string; readonly session: ManagedProblemSession }
  | { readonly key: string; readonly error: string };

export function ManagedProblemWorkspace({ problemVersionId, contestId }: ManagedProblemContext) {
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
  const [problemLocale, setProblemLocale] = useState<ProblemLocale>(() => {
    if (typeof window === "undefined") return DEFAULT_JUDGE_UI_LOCALE;
    try {
      return readJudgeUiLocale(localStorage, navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en");
    } catch {
      return DEFAULT_JUDGE_UI_LOCALE;
    }
  });
  const [loadState, setLoadState] = useState<ManagedProblemLoadState>();
  const [retry, setRetry] = useState(0);
  const text = judgeUiText(problemLocale);
  const loadKey = parsedContext.ok
    ? `${parsedContext.context.contestId ?? "practice"}:${parsedContext.context.problemVersionId}:${retry}`
    : `invalid:${retry}`;

  useEffect(() => {
    document.documentElement.lang = problemLocale === "zh-TW" ? "zh-Hant" : "en";
  }, [problemLocale]);

  useEffect(() => {
    if (!parsedContext.ok) return;
    const controller = new AbortController();
    void (async () => {
      const collection = await loadManagedProblemCollection(parsedContext.context, { signal: controller.signal });
      const entry = collection.index.problems[0];
      if (!entry) throw new Error("The managed problem projection is empty.");
      const problem = await collection.loadProblem(entry.id, controller.signal);
      if (!controller.signal.aborted) setLoadState({ key: loadKey, session: { collection, problem } });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState({ key: loadKey, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [loadKey, parsedContext]);

  const changeLocale = useCallback((locale: ProblemLocale) => {
    setProblemLocale(locale);
    try {
      writeJudgeUiLocale(localStorage, locale);
    } catch {
      // The selected locale still applies to this in-memory workspace.
    }
  }, []);

  const currentLoadState = loadState?.key === loadKey ? loadState : undefined;
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
    <JudgeStudio
      key={currentLoadState.session.collection.sourceKey}
      collection={currentLoadState.session.collection}
      initialProblem={currentLoadState.session.problem}
      problemLocale={problemLocale}
      onProblemLocaleChange={changeLocale}
      managedContext={parsedContext.context}
    />
  );
}
