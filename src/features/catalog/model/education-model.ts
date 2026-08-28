"use client";

import { useEffect, useState } from "react";
import type { SubmissionState, SubmissionVerdict } from "../../../online-judge/contracts";
import type { ContestProjection } from "../../contests/model/contest-projection";
import type { ProductLocale } from "../../platform/components/app-shell";
import { wasmOjJson } from "../../platform/api/online-api";

export interface CatalogProblem {
  readonly id: string;
  readonly slug: string;
  readonly number: number;
  readonly title: Record<string, string>;
  readonly summary: Record<string, string>;
  readonly practiceEnabled: true;
  readonly catalogCommit: string;
  readonly judgeDigest: string;
  readonly contentDigest: string;
  readonly contentUrl: string;
  readonly maximumScore: number;
  readonly solved: boolean;
  readonly bestScore: number | null;
}

export interface CatalogCollection {
  readonly catalogId: string;
  readonly catalogCommit: string;
  readonly repository: { readonly id: number; readonly owner: string; readonly name: string };
  readonly official: boolean;
  readonly problems: readonly CatalogProblem[];
}

export type ContestSummary = ContestProjection;

export interface SubmissionSummary {
  readonly id: string;
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly judgeDigest: string;
  readonly contestId: string | null;
  readonly language: string;
  readonly state: SubmissionState;
  readonly verdict: SubmissionVerdict | null;
  readonly visibility: "private" | "public";
  readonly score: number | null;
  readonly fullyPassedCases: number | null;
  readonly deterministicCost: number | null;
  readonly peakMemoryBytes: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly stale?: boolean;
  readonly judgedCommit?: string;
  readonly activeCommit?: string | null;
  readonly owner?: boolean;
  readonly sourceAvailable?: boolean;
  readonly problem: { readonly slug: string; readonly title: Record<string, string> } | null;
  readonly contest: { readonly id: string; readonly title: string } | null;
}

export interface Profile {
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly visibility: "public" | "private";
  readonly login: string;
  readonly avatarUrl: string;
  readonly verifiedSolvedCount: number;
}

export const copy = {
  en: {
    greeting: "Welcome to WASM-OJ", subtitle: "Practice programming in your browser, then submit for a verified result when you are ready.",
    start: "Start official practice", official: "Official practice", officialNote: "Curated problems maintained by WASM-OJ.",
    progress: "Your progress", solved: "solved", continue: "Continue learning", noDraft: "Choose a problem to begin. Your code stays in this browser.",
    contests: "Contests", upcoming: "Upcoming and active competitions", recent: "Recent submissions", all: "View all",
    catalog: "Problems", catalogIntro: "Browse the practice projection from each repository's active commit.",
    search: "Search by title, number, or summary…", difficulty: "All difficulties", topic: "All topics", status: "All status",
    unsolved: "Unsolved", empty: "No problems match these filters.", open: "Open problem",
    submissions: "Submissions", submissionsIntro: "Your verified server submissions. Browser-local runs never appear here.", noSubmissions: "No official submissions yet.",
    profile: "Profile settings", profileIntro: "Choose what other learners can see.", save: "Save profile", saved: "Profile saved.",
    custom: "Custom collections", customIntro: "Load any credential-free public GitHub collection for advanced browser-local practice.",
    openCustom: "Open custom collection workspace", signIn: "Sign in with GitHub", anonymous: "You can run every public practice problem without an account.",
  },
  "zh-TW": {
    greeting: "歡迎來到 WASM-OJ", subtitle: "先在瀏覽器練習程式設計，準備好後再正式提交取得驗證結果。",
    start: "開始官方練習", official: "官方題庫", officialNote: "由 WASM-OJ 維護的精選練習題。",
    progress: "你的進度", solved: "題已完成", continue: "繼續學習", noDraft: "選一題開始。你的程式碼會留在這個瀏覽器。",
    contests: "競賽", upcoming: "進行中與即將開始的競賽", recent: "最近提交", all: "查看全部",
    catalog: "題庫", catalogIntro: "瀏覽各 repository 目前 active commit 的練習題投影。",
    search: "搜尋標題、題號或摘要…", difficulty: "所有難度", topic: "所有主題", status: "所有狀態",
    unsolved: "未解", empty: "沒有符合篩選條件的題目。", open: "開始解題",
    submissions: "提交紀錄", submissionsIntro: "這裡只顯示 Server 驗證的正式提交；瀏覽器本機執行不會出現在這裡。", noSubmissions: "還沒有正式提交。",
    profile: "個人檔案設定", profileIntro: "決定其他學習者能看到哪些資料。", save: "儲存個人檔案", saved: "個人檔案已儲存。",
    custom: "自訂題庫", customIntro: "載入任意不需帳號的公開 GitHub collection，進行進階本機練習。",
    openCustom: "開啟自訂題庫工作區", signIn: "使用 GitHub 登入", anonymous: "所有公開練習題都可以不登入直接在瀏覽器執行。",
  },
} as const;

export function localized(value: Record<string, string> | undefined, locale: ProductLocale, fallback = "Untitled"): string {
  return value?.[locale] ?? value?.en ?? value?.["zh-TW"] ?? fallback;
}

export function formatDate(value: string, locale: ProductLocale): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function useCatalog() {
  const [collections, setCollections] = useState<readonly CatalogCollection[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void wasmOjJson<{ catalogs: readonly CatalogCollection[] }>("/api/problems", { signal: controller.signal })
      .then((value) => setCollections(value.catalogs))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return { collections, error, loading };
}

export function draftLink(projectId: string): string {
  const match = /^judge:(.+):[0-9a-f]{64}:([^:]+):(?:c|cpp|rust|python|javascript|typescript|go)$/.exec(projectId);
  if (!match) return "/collections/custom";
  let sourceKey: string;
  try { sourceKey = decodeURIComponent(match[1]); } catch { return "/collections/custom"; }
  const practice = /^managed:official-practice:([0-9a-f-]{36}):/.exec(sourceKey);
  if (practice) return `/problems/${practice[1]}`;
  const contest = /^managed:contest:([0-9a-f-]{36}):([0-9a-f-]{36}):/.exec(sourceKey);
  return contest ? `/contests/${contest[1]}/problems/${contest[2]}` : "/collections/custom";
}
