"use client";

import {
  BrainCircuit,
  CheckCircle2,
  Clock3,
  CodeXml,
  GitBranch,
  Hourglass,
  LockKeyhole,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useProduct } from "../../platform/components/app-shell";
import { localized } from "../../catalog/model/education-model";
import { LeaderboardTable, type PublicLeaderboardEntry } from "./leaderboard-table";
import { wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import { usePageTitle } from "../../platform/hooks/page-title";
import { managedProblemWorkspacePath } from "../../../online-judge/managed-problem-collection";
import {
  contestBatchProgress,
  contestEffectiveWallTime,
  contestEnrollmentWindowOpen,
  formatLogicalDuration,
  isRevealedContestProblem,
  nextContestBoundaryDelayMs,
  nextContestWallBoundaryDelayMs,
  projectedLogicalSeconds,
  type ContestDetailResponse,
  type ContestProblemProjection,
  type ContestProjection,
} from "../model/contest-projection";

function phaseLabel(contest: ContestProjection, zh: boolean): string {
  const labels: Record<ContestProjection["phase"], readonly [string, string]> = {
    registration: ["Registration", "報名中"],
    upcoming: ["Upcoming", "尚未開始"],
    "awaiting-start": ["Ready to start", "等待開始"],
    running: ["Running", "進行中"],
    paused: ["Paused", "已暫停"],
    ended: ["Ended", "已結束"],
    eliminated: ["Eliminated", "已淘汰"],
  };
  return labels[contest.phase][zh ? 1 : 0];
}

function trackLabel(contest: ContestProjection, zh: boolean): string {
  if (contest.officialTrack.kind === "prompt-program") return "Prompt Program";
  if (contest.officialTrack.aiAssist === "allowed") return zh ? "程式碼 · 可使用 AI 輔助" : "Code · AI assistance allowed";
  return zh ? "程式碼 · 禁用 AI 輔助" : "Code · AI assistance disabled";
}

function clockWindow(contest: ContestProjection, locale: string, zh: boolean): { primary: string; secondary: string } {
  if (contest.clock.kind === "global") {
    return {
      primary: new Date(contestEffectiveWallTime(contest.clock.startsAt, contest.scheduleShiftSeconds)).toLocaleString(locale),
      secondary: `${zh ? "全場" : "Global"} · ${formatLogicalDuration(contest.clock.durationSeconds)}`,
    };
  }
  return {
    primary: `${new Date(contestEffectiveWallTime(contest.clock.enrollmentOpensAt, contest.scheduleShiftSeconds)).toLocaleString(locale)} – ${new Date(contestEffectiveWallTime(contest.clock.enrollmentClosesAt, contest.scheduleShiftSeconds)).toLocaleString(locale)}`,
    secondary: `${zh ? "個人計時" : "Individual"} · ${formatLogicalDuration(contest.clock.durationSeconds)}`,
  };
}

function availabilityLabel(problem: ContestProblemProjection, zh: boolean): string {
  if (problem.availability === "locked") return zh ? "尚未揭題" : "Locked";
  if (problem.availability === "closed") return zh ? "已截止 · 唯讀" : "Closed · read only";
  return zh ? "可提交" : "Open";
}

export function ContestOverview({ contestId }: { readonly contestId: string }) {
  const { locale, session } = useProduct();
  const zh = locale === "zh-TW";
  const [detail, setDetail] = useState<ContestDetailResponse>();
  const [entries, setEntries] = useState<PublicLeaderboardEntry[]>([]);
  const [frozen, setFrozen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const contest = detail?.contest;
  const problems = detail?.problems ?? [];
  usePageTitle(contest?.title ?? (zh ? "競賽" : "Contest"));

  const load = useCallback(async () => {
    const next = await wasmOjJson<ContestDetailResponse>(`/api/contests/${encodeURIComponent(contestId)}`);
    const observedAt = Date.now();
    setDetail(next);
    setFetchedAt(observedAt);
    setNow(observedAt);
    if (next.contest.joined || next.contest.organizer) {
      const board = await wasmOjJson<{ frozen: boolean; hidden: boolean; entries: PublicLeaderboardEntry[] }>(`/api/contests/${encodeURIComponent(contestId)}/leaderboard`);
      setEntries(board.entries);
      setFrozen(board.frozen);
      setHidden(board.hidden);
    } else {
      setEntries([]);
      setFrozen(false);
      setHidden(false);
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
    if (contest?.runtimeState !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [contest?.runtimeState]);

  useEffect(() => {
    if (!contest) return;
    const refresh = () => void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
    const logicalDelay = nextContestBoundaryDelayMs(contest, fetchedAt, Date.now());
    const wallDelay = nextContestWallBoundaryDelayMs(contest, Date.now());
    const delays = [logicalDelay, wallDelay].filter((value): value is number => value !== undefined);
    const delay = delays.length === 0 ? undefined : Math.min(...delays);
    const timer = delay === undefined
      ? undefined
      : window.setTimeout(refresh, Math.min(2_147_000_000, delay + 150));
    window.addEventListener("focus", refresh);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [contest, fetchedAt, load]);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await wasmOjMutation(`/api/contests/${encodeURIComponent(contestId)}/join`, inviteCode ? { inviteCode } : {});
      await load();
      setMessage(zh ? "已加入競賽。" : "Contest joined.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setMessage("");
    try {
      await wasmOjMutation(`/api/contests/${encodeURIComponent(contestId)}/start`, {});
      await load();
      setMessage(zh ? "個人計時已開始；這個動作無法復原。" : "Your individual clock has started and cannot be undone.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const logicalSeconds = contest ? projectedLogicalSeconds(contest, fetchedAt, now) : null;
  const nextBoundaryRemaining = contest && logicalSeconds !== null && contest.nextBoundarySeconds !== null
    ? Math.max(0, contest.nextBoundarySeconds - logicalSeconds)
    : null;
  const contestRemaining = contest && logicalSeconds !== null
    ? Math.max(0, contest.clock.durationSeconds - logicalSeconds)
    : null;
  const batches = contestBatchProgress(problems);
  const joinOpen = contest && contest.phase === "registration" && !contest.joined && !contest.organizer;
  const canStart = contest?.clock.kind === "individual" && contest.phase === "awaiting-start"
    && contest.joined && contest.entrant && !contest.entrant.started && contestEnrollmentWindowOpen(contest, now);
  const problemColumns = problems.filter(isRevealedContestProblem)
    .map((problem) => ({ id: problem.problemId, label: String(problem.ordinal) }));

  return <main className="product-page" id="main-content">
    <header className="product-page-header">
      <Link className="product-back" href="/contests">← {zh ? "競賽" : "Contests"}</Link>
      <h1>{contest?.title ?? (zh ? "競賽" : "Contest")}</h1>
      <p>{contest?.description}</p>
    </header>
    {loading && !contest && !message && <section className="product-empty large" role="status">{zh ? "載入競賽…" : "Loading contest…"}</section>}
    {contest && <>
      {contest.publicRepositoryTimingWarning && <section className="contest-alert warning" role="note">
        <ShieldAlert size={18} />
        <div><strong>{zh ? "公開 Repository 無法保密題目" : "Public repositories cannot keep staged problems secret"}</strong><p>{zh ? "平台會依時間鎖定介面，但 GitHub 上的內容可能提前曝光。" : contest.publicRepositoryTimingWarning.message}</p></div>
      </section>}
      {contest.paused && <section className="contest-alert paused" role="status">
        <PauseCircle size={18} />
        <div><strong>{zh ? "競賽已暫停" : "Contest paused"}</strong><p>{contest.pauseReason ?? (zh ? "邏輯時間、揭題與正式提交都已凍結。" : "Logical time, reveals, and official admission are frozen.")}</p></div>
      </section>}
      {contest.entrant?.state === "eliminated" && <section className="contest-alert danger" role="status">
        <ShieldAlert size={18} />
        <div><strong>{zh ? "你已被淘汰" : "You have been eliminated"}</strong><p>{contest.entrant.eliminationReason ?? (zh ? "既有題目保持唯讀；未來題目不再揭露，且無法繼續提交。" : "Revealed problems remain read only; future problems and submissions are unavailable.")}</p></div>
      </section>}
      {contest.judgeProvisional && <section className="contest-alert provisional" role="status">
        <Hourglass size={18} />
        <div><strong>{zh ? "排行榜暫定" : "Leaderboard provisional"}</strong><p>{zh ? "新 judge epoch 正在重新判題；切換前仍顯示完整的舊榜，不混用兩個版本。" : "A new judge epoch is rolling out. The complete prior board remains effective until the atomic switch."}</p></div>
      </section>}

      <section className="contest-facts contest-facts-v2">
        <div><span>{zh ? "時鐘" : "Clock"}</span><strong>{clockWindow(contest, locale, zh).primary}</strong><small>{clockWindow(contest, locale, zh).secondary}</small></div>
        <div><span>{zh ? "官方模式" : "Official track"}</span><strong className="contest-mode-label">{contest.officialTrack.kind === "prompt-program" ? <BrainCircuit size={16} /> : <CodeXml size={16} />}{trackLabel(contest, zh)}</strong><small>{contest.scoring.kind.toUpperCase()} · {contest.evidenceAt}</small></div>
        <div><span>{zh ? "狀態" : "Status"}</span><strong>{phaseLabel(contest, zh)}</strong><small>{contest.accessMode} · {contest.joined ? (zh ? "已加入" : "joined") : contest.organizer ? "Organizer preview" : (zh ? "尚未加入" : "not joined")}</small></div>
        <div className="contest-countdown"><span>{zh ? "邏輯倒數" : "Logical countdown"}</span><strong>{nextBoundaryRemaining === null ? "—" : formatLogicalDuration(nextBoundaryRemaining)}</strong><small>{contest.paused ? (zh ? "暫停中" : "frozen while paused") : contestRemaining === null ? (zh ? "尚未開始" : "not started") : `${zh ? "全場剩餘" : "contest remaining"} ${formatLogicalDuration(contestRemaining)}`}</small></div>
      </section>

      {batches.length > 1 && <section className="contest-progress-section" aria-labelledby="contest-batch-heading">
        <header><h2 id="contest-batch-heading">{zh ? "批次進度" : "Batch progress"}</h2><span>{batches.filter((batch) => batch.locked === 0).length} / {batches.length}</span></header>
        <ol className="contest-batch-rail">{batches.map((batch) => <li className={batch.open > 0 ? "is-open" : batch.locked === 0 ? "is-past" : "is-locked"} key={batch.batch}>
          <span>{batch.batch}</span><div><strong>{zh ? `批次 ${batch.batch}` : `Batch ${batch.batch}`}</strong><small>{batch.open > 0 ? `${batch.open} ${zh ? "題開放" : "open"}` : batch.locked > 0 ? `${batch.locked} ${zh ? "題待揭露" : "locked"}` : `${batch.closed} ${zh ? "題截止" : "closed"}`}</small></div>
        </li>)}</ol>
      </section>}

      {contest.checkpoints.length > 0 && <section className="contest-progress-section" aria-labelledby="contest-checkpoint-heading">
        <header><h2 id="contest-checkpoint-heading">{zh ? "關卡" : "Checkpoints"}</h2><span>{contest.checkpoints.filter((checkpoint) => checkpoint.decision === "advanced").length} / {contest.checkpoints.length}</span></header>
        <ol className="contest-checkpoint-list">{contest.checkpoints.map((checkpoint) => <li className={`state-${checkpoint.state}`} key={checkpoint.id}>
          <span>{checkpoint.decision === "advanced" ? <CheckCircle2 size={15} /> : checkpoint.provisional || checkpoint.state === "evaluating" ? <Hourglass size={15} /> : <Clock3 size={15} />}</span>
          <div><strong>{checkpoint.id}</strong><small>{formatLogicalDuration(checkpoint.atSeconds)} · {checkpoint.settlement}</small></div>
          <b>{checkpoint.provisional ? (zh ? "暫定晉級" : "provisional") : checkpoint.decision ? (checkpoint.decision === "advanced" ? (zh ? "晉級" : "advanced") : (zh ? "淘汰" : "eliminated")) : checkpoint.state}</b>
        </li>)}</ol>
      </section>}

      {joinOpen && !session?.authenticated && <section className="contest-join"><LockKeyhole size={20} /><div><h2>{zh ? "登入後加入競賽" : "Sign in to join"}</h2><p>{zh ? "Public 只代表不需邀請碼；正式參賽仍必須加入。" : "Public means no invite code is required; every official entrant must still join."}</p></div><a className="primary-action" href={`/api/auth/github?return=${encodeURIComponent(`/contests/${contestId}`)}`}><GitBranch size={16} />{zh ? "使用 GitHub 登入" : "Sign in with GitHub"}</a></section>}
      {joinOpen && session?.authenticated && <form className="contest-join organizer-product-form" onSubmit={(event) => void join(event)}><div><h2>{zh ? "加入競賽" : "Join contest"}</h2><p>{contest.paused ? (zh ? "暫停期間無法加入。" : "Joining is unavailable while paused.") : contest.accessMode === "invite" ? (zh ? "輸入 Organizer 提供的邀請碼。" : "Enter the invite code provided by the Organizer.") : (zh ? "加入後才會建立正式參賽者身份。" : "Joining creates your official entrant identity.")}</p></div>{contest.accessMode === "invite" && <label>{zh ? "邀請碼" : "Invite code"}<input value={inviteCode} minLength={16} maxLength={128} required autoComplete="off" onChange={(event) => setInviteCode(event.target.value)} /></label>}<button className="primary-action" disabled={busy || contest.paused}>{busy ? (zh ? "加入中…" : "Joining…") : (zh ? "加入競賽" : "Join contest")}</button></form>}
      {canStart && <section className="contest-start"><div><Play size={19} /><div><h2>{zh ? "準備好再開始" : "Start when you are ready"}</h2><p>{zh ? `開始後會立即啟動 ${formatLogicalDuration(contest.clock.durationSeconds)} 的個人時鐘，且無法復原。` : `Start launches your ${formatLogicalDuration(contest.clock.durationSeconds)} individual clock immediately and cannot be undone.`}</p></div></div><button className="primary-action" type="button" disabled={busy} onClick={() => void start()}>{busy ? (zh ? "開始中…" : "Starting…") : (zh ? "開始個人計時" : "Start individual clock")}</button></section>}

      <section className="organizer-product-section"><h2>{zh ? "題目" : "Problems"}</h2><div className="contest-problem-list contest-problem-list-v2">{problems.map((problem) => {
        const status = <span className={`contest-problem-state state-${problem.availability}`}>{availabilityLabel(problem, zh)}</span>;
        const timing = <small>{zh ? "批次" : "Batch"} {problem.batch} · {problem.points} pt · {zh ? "額度" : "attempts"} {problem.attemptsRemaining}/{problem.attemptLimit}</small>;
        if (!isRevealedContestProblem(problem)) return <div className="contest-problem-row is-locked" key={`${problem.batch}:${problem.ordinal}`}><span>{problem.ordinal}</span><div><strong>{zh ? "尚未揭露" : "Unrevealed problem"}</strong>{timing}</div>{status}</div>;
        return <Link className={`contest-problem-row is-${problem.availability}`} key={problem.problemId} href={managedProblemWorkspacePath({ contestId, problemId: problem.problemId })}><span>{problem.ordinal}</span><div><strong>{localized(problem.title, locale, problem.problemSlug)}</strong>{timing}</div>{status}</Link>;
      })}</div>{problems.length === 0 && <p className="product-empty">{contest.phase === "upcoming" ? (zh ? "題目會依競賽規則揭露。" : "Problems reveal according to the contest rules.") : contest.accessMode === "invite" && !contest.joined && !contest.organizer ? (zh ? "加入後才能查看邀請競賽題目。" : "Join this invite-only contest to view its problems.") : (zh ? "目前沒有題目。" : "No problems are available.")}</p>}</section>
      <section className="organizer-product-section"><h2>{zh ? "排行榜" : "Leaderboard"}</h2>{frozen && <p className="product-message"><LockKeyhole size={14} /> {zh ? "排行榜已凍結；競賽結束後會顯示完整結果。" : "Leaderboard frozen; the complete board returns after the contest."}</p>}{hidden ? <p className="product-empty"><LockKeyhole size={16} /> {zh ? "排行榜會在競賽結束後公開。" : "The leaderboard is hidden until the contest ends."}</p> : <LeaderboardTable entries={entries} showProblems problemColumns={problemColumns} scoringKind={contest.scoring.kind} checkpointCount={contest.checkpoints.length} locale={zh ? "zh-TW" : "en-US"} />}{!contest.joined && !contest.organizer && <p className="product-empty">{zh ? "加入後才能查看排行榜。" : "Join the contest to view its leaderboard."}</p>}</section>
    </>}
    {message && <output className="product-message" role="status">{message} <button type="button" aria-label={zh ? "重新載入競賽" : "Reload contest"} onClick={() => void load()}><RefreshCw size={14} /></button></output>}
  </main>;
}
