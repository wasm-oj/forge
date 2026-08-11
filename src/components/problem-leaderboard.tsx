"use client";

import { ChevronDown, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { isBuiltinLanguage, type BuiltinLanguage } from "../core/types";
import { languageLabel } from "../core/toolchains";
import { forgeJson } from "./online-api";
import { LeaderboardTable, type PublicLeaderboardEntry } from "./leaderboard-table";
import type { ProblemLocale } from "../judge/problem-model";

export interface ProblemLeaderboardResponse {
  readonly availableLanguages: readonly BuiltinLanguage[];
  readonly selectedLanguage: BuiltinLanguage | null;
  readonly entries: readonly PublicLeaderboardEntry[];
}

type ProblemLeaderboardLoadState =
  | { readonly key: string; readonly response: ProblemLeaderboardResponse }
  | { readonly key: string; readonly error: string };

export function problemLeaderboardApiPath(problemVersionId: string, language: BuiltinLanguage | "all"): string {
  const parameters = new URLSearchParams({ limit: "100" });
  if (language !== "all") parameters.set("language", language);
  return `/api/problems/${encodeURIComponent(problemVersionId)}/leaderboard?${parameters.toString()}`;
}

export function ProblemLeaderboardView({
  locale,
  language,
  response,
  loading,
  error,
  onLanguageChange,
}: {
  readonly locale: ProblemLocale;
  readonly language: BuiltinLanguage | "all";
  readonly response?: ProblemLeaderboardResponse;
  readonly loading: boolean;
  readonly error?: string;
  onLanguageChange(language: BuiltinLanguage | "all"): void;
}) {
  const chinese = locale === "zh-TW";
  return <section aria-label={chinese ? "題目排名" : "Problem ranking"}>
    <div className="online-section-heading">
      <div>
        <h2><Trophy size={14} /> {chinese ? "題目排名" : "Problem ranking"}</h2>
        <p>{chinese ? "每位使用者只採計目前篩選語言中的最佳正式提交。" : "Each participant is ranked by their best official submission in the selected language."}</p>
      </div>
      <label className="compact-select">
        <select
          value={language}
          aria-label={chinese ? "依程式語言篩選排名" : "Filter ranking by language"}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "all" || isBuiltinLanguage(value)) onLanguageChange(value);
          }}
        >
          <option value="all">{chinese ? "所有語言" : "All languages"}</option>
          {(response?.availableLanguages ?? []).map((value) => <option value={value} key={value}>{languageLabel(value)}</option>)}
        </select>
        <ChevronDown size={12} />
      </label>
    </div>
    {loading && <div className="online-empty" role="status">{chinese ? "載入排名中…" : "Loading ranking…"}</div>}
    {error && <div className="online-error" role="alert">{error}</div>}
    {!loading && !error && response && (response.entries.length > 0
      ? <LeaderboardTable entries={response.entries} showLanguage />
      : <div className="online-empty">{chinese ? "這個篩選條件還沒有正式提交。" : "No official submissions match this filter yet."}</div>)}
  </section>;
}

export function ProblemLeaderboard({
  problemVersionId,
  locale,
  refreshKey,
}: {
  readonly problemVersionId: string;
  readonly locale: ProblemLocale;
  readonly refreshKey?: string;
}) {
  const [language, setLanguage] = useState<BuiltinLanguage | "all">("all");
  const [loadState, setLoadState] = useState<ProblemLeaderboardLoadState>();
  const requestKey = `${problemVersionId}:${language}:${refreshKey ?? "initial"}`;

  useEffect(() => {
    const controller = new AbortController();
    void forgeJson<ProblemLeaderboardResponse>(problemLeaderboardApiPath(problemVersionId, language), {
      signal: controller.signal,
    }).then((value) => {
      if (controller.signal.aborted) return;
      setLoadState({ key: requestKey, response: value });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setLoadState({ key: requestKey, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [language, problemVersionId, requestKey]);

  const current = loadState?.key === requestKey ? loadState : undefined;

  return <ProblemLeaderboardView
    locale={locale}
    language={language}
    response={current && "response" in current ? current.response : undefined}
    loading={!current}
    error={current && "error" in current ? current.error : undefined}
    onLanguageChange={setLanguage}
  />;
}
