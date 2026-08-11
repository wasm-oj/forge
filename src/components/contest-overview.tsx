"use client";

import { GitBranch, LockKeyhole, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useProduct } from "./app-shell";
import { localized } from "./education-model";
import { LeaderboardTable, type PublicLeaderboardEntry } from "./leaderboard-table";
import { forgeJson, forgeMutation } from "./online-api";
import { usePageTitle } from "./page-title";
import { managedProblemWorkspacePath } from "../online-judge/managed-problem-collection";

interface ContestDetail {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly accessMode: "public" | "invite";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly freezeAt: string | null;
  readonly status: string;
  readonly phase: "upcoming" | "running" | "ended";
  readonly joined: boolean;
  readonly organizer: boolean;
}

interface ContestProblem {
  readonly ordinal: number;
  readonly problemVersionId: string;
  readonly problemSlug: string;
  readonly title: Record<string, string>;
}

export function nextContestBoundary(contest: Pick<ContestDetail, "startsAt" | "freezeAt" | "endsAt">, now: number): number | undefined {
  return [contest.startsAt, contest.freezeAt, contest.endsAt]
    .flatMap((value) => value ? [Date.parse(value)] : [])
    .filter((value) => Number.isFinite(value) && value > now)
    .sort((left, right) => left - right)[0];
}

export function ContestOverview({ contestId }: { readonly contestId: string }) {
  const { locale, session } = useProduct();
  const zh = locale === "zh-TW";
  const [contest, setContest] = useState<ContestDetail>();
  const [problems, setProblems] = useState<ContestProblem[]>([]);
  const [entries, setEntries] = useState<PublicLeaderboardEntry[]>([]);
  const [frozen, setFrozen] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  usePageTitle(contest?.title ?? (zh ? "競賽" : "Contest"));

  const load = useCallback(async () => {
    const detail = await forgeJson<{ contest: ContestDetail; problems: ContestProblem[] }>(`/api/contests/${encodeURIComponent(contestId)}`);
    setContest(detail.contest);
    setProblems(detail.problems);
    if (detail.contest.accessMode === "public" || detail.contest.joined || detail.contest.organizer) {
      const board = await forgeJson<{ frozen: boolean; entries: PublicLeaderboardEntry[] }>(`/api/contests/${encodeURIComponent(contestId)}/leaderboard`);
      setEntries(board.entries);
      setFrozen(board.frozen);
    } else {
      setEntries([]);
      setFrozen(false);
    }
    setLoading(false);
  }, [contestId]);

  useEffect(() => {
    const controller = window.setTimeout(() => void load().catch((error: unknown) => {
      setLoading(false);
      setMessage(error instanceof Error ? error.message : String(error));
    }), 0);
    return () => window.clearTimeout(controller);
  }, [load]);

  useEffect(() => {
    if (!contest) return;
    const refresh = () => void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
    const boundary = nextContestBoundary(contest, Date.now());
    const timer = boundary === undefined
      ? undefined
      : window.setTimeout(refresh, Math.min(2_147_000_000, Math.max(0, boundary - Date.now() + 100)));
    window.addEventListener("focus", refresh);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [contest, load]);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await forgeMutation(`/api/contests/${encodeURIComponent(contestId)}/join`, inviteCode ? { inviteCode } : {});
      await load();
      setMessage(zh ? "已加入競賽。" : "Contest joined.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const joinOpen = contest && contest.phase !== "ended" && !contest.joined && !contest.organizer;
  const problemColumns = problems.map((problem) => ({ id: problem.problemVersionId, label: String(problem.ordinal) }));

  return <main className="product-page" id="main-content">
    <header className="product-page-header"><Link className="product-back" href="/contests">← {zh ? "競賽" : "Contests"}</Link><h1>{contest?.title ?? (zh ? "競賽" : "Contest")}</h1><p>{contest?.description}</p></header>
    {loading && !contest && !message && <section className="product-empty large">{zh ? "載入競賽…" : "Loading contest…"}</section>}
    {contest && <>
      <section className="contest-facts"><div><span>{zh ? "時間" : "Schedule"}</span><strong>{new Date(contest.startsAt).toLocaleString(locale)}</strong><small>{zh ? "至" : "to"} {new Date(contest.endsAt).toLocaleString(locale)}</small></div><div><span>{zh ? "存取" : "Access"}</span><strong>{contest.accessMode}</strong><small>{contest.joined ? (zh ? "已加入" : "Joined") : contest.organizer ? "Organizer" : (zh ? "尚未加入" : "Not joined")}</small></div><div><span>{zh ? "狀態" : "Status"}</span><strong>{contest.phase}</strong><small>{contest.freezeAt ? `${zh ? "凍結" : "Freeze"} ${new Date(contest.freezeAt).toLocaleString(locale)}` : (zh ? "即時排行榜" : "Live leaderboard")}</small></div></section>
      {joinOpen && !session?.authenticated && <section className="contest-join"><LockKeyhole size={20} /><div><h2>{zh ? "登入後加入競賽" : "Sign in to join"}</h2><p>{zh ? "可先查看競賽資訊；正式提交前需要 GitHub 帳號。" : "You can review the contest first. A GitHub account is required to submit."}</p></div><a className="primary-action" href={`/api/auth/github?return=${encodeURIComponent(`/contests/${contestId}`)}`}><GitBranch size={16} />{zh ? "使用 GitHub 登入" : "Sign in with GitHub"}</a></section>}
      {joinOpen && session?.authenticated && <form className="contest-join organizer-product-form" onSubmit={(event) => void join(event)}><div><h2>{zh ? "加入競賽" : "Join contest"}</h2><p>{contest.accessMode === "invite" ? (zh ? "輸入 Organizer 提供的邀請碼。" : "Enter the invite code provided by the Organizer.") : (zh ? "加入後即可正式提交。" : "Join to make verified submissions.")}</p></div>{contest.accessMode === "invite" && <label>{zh ? "邀請碼" : "Invite code"}<input value={inviteCode} minLength={16} maxLength={128} required autoComplete="off" onChange={(event) => setInviteCode(event.target.value)} /></label>}<button className="primary-action" disabled={busy}>{busy ? (zh ? "加入中…" : "Joining…") : (zh ? "加入競賽" : "Join contest")}</button></form>}
      <section className="organizer-product-section"><h2>{zh ? "題目" : "Problems"}</h2><div className="contest-problem-list">{problems.map((problem) => <Link key={problem.problemVersionId} href={managedProblemWorkspacePath({ contestId, problemVersionId: problem.problemVersionId })}><span>{problem.ordinal}</span><strong>{localized(problem.title, locale, problem.problemSlug)}</strong><span>{zh ? "開啟 →" : "Open →"}</span></Link>)}</div>{problems.length === 0 && <p className="product-empty">{contest.phase === "upcoming" ? (zh ? "題目將在競賽開始時公開。" : "Problems open when the contest starts.") : contest.accessMode === "invite" && !contest.joined && !contest.organizer ? (zh ? "加入後才能查看邀請競賽題目。" : "Join this invite-only contest to view its problems.") : (zh ? "目前沒有題目。" : "No problems are available.")}</p>}</section>
      <section className="organizer-product-section"><h2>{zh ? "排行榜" : "Leaderboard"}</h2>{frozen && <p className="product-message"><LockKeyhole size={14} /> {zh ? "排行榜已凍結；目前顯示凍結前的成績，競賽結束後會自動更新。" : "Leaderboard frozen: results shown are from before the freeze and will refresh when the contest ends."}</p>}<LeaderboardTable entries={entries} showProblems problemColumns={problemColumns} />{contest.accessMode === "invite" && !contest.joined && !contest.organizer && <p className="product-empty">{zh ? "加入後才能查看邀請競賽排行榜。" : "Join this invite-only contest to view its leaderboard."}</p>}</section>
    </>}
    {message && <output className="product-message" role="status">{message} <button type="button" aria-label={zh ? "重新載入競賽" : "Reload contest"} onClick={() => void load()}><RefreshCw size={14} /></button></output>}
  </main>;
}
