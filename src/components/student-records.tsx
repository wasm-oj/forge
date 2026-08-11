"use client";

import { ChevronRight, Clock3, GitBranch, Globe2, ListChecks, LockKeyhole, RefreshCw, Trophy, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { isTerminalSubmissionState, type SequencedSubmissionEvent, type SubmissionVerdict } from "../online-judge/contracts";
import { SubmissionEventPollingClient, type SubmissionPollingConnectionState } from "../online-judge/submission-event-polling";
import { useProduct } from "./app-shell";
import { copy, formatDate, localized, type ContestSummary, type SubmissionSummary } from "./education-model";
import { executionTerminationLabel, verdictLabel } from "./judge-ui-i18n";
import { forgeJson, forgeMutation } from "./online-api";
import { usePageTitle } from "./page-title";
import { submissionCostPresentation } from "./submission-cost";

export function ContestList() {
  const { locale } = useProduct();
  const [contests, setContests] = useState<readonly ContestSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  usePageTitle(locale === "zh-TW" ? "競賽" : "Contests");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const value = await forgeJson<{ contests: readonly ContestSummary[] }>("/api/contests?limit=100");
      setContests(value.contests);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  if (loading) return <main className="product-page" id="main-content"><div className="product-empty large" role="status">{locale === "zh-TW" ? "載入競賽…" : "Loading contests…"}</div></main>;
  if (error) return <main className="product-page" id="main-content"><div className="product-error" role="alert">{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} /> {locale === "zh-TW" ? "重試" : "Retry"}</button></div></main>;
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><Trophy size={14} /> Compete</span><h1>{copy[locale].contests}</h1><p>{copy[locale].upcoming}</p></header>{error && <div className="product-error">{error}</div>}<div className="contest-catalog">{(["running", "upcoming", "ended"] as const).map((phase) => <section key={phase}><h2>{phase}</h2><div className="contest-card-grid">{contests.filter((contest) => contest.phase === phase).map((contest) => <Link className="contest-card" key={contest.id} href={`/contests/${contest.id}`}><div><span className={`contest-phase ${phase}`}>{phase}</span><span>{contest.accessMode}</span></div><h3>{contest.title}</h3><p>{contest.description}</p><footer><span><Clock3 size={14} />{formatDate(contest.startsAt, locale)}</span><ChevronRight size={16} /></footer></Link>)}</div>{contests.filter((contest) => contest.phase === phase).length === 0 && <p className="product-empty">No {phase} contests.</p>}</section>)}</div></main>;
}

function SignInEmpty({ returnPath }: { readonly returnPath: string }) {
  const { locale } = useProduct();
  return <div className="sign-in-empty"><UserRound size={30} /><h2>{copy[locale].signIn}</h2><p>{copy[locale].anonymous}</p><a className="primary-action" href={`/api/auth/github?return=${encodeURIComponent(returnPath)}`}><GitBranch size={16} />{copy[locale].signIn}</a></div>;
}

function submissionVerdictLabel(locale: "en" | "zh-TW", verdict: SubmissionVerdict): string {
  switch (verdict) {
    case "instruction-limit":
    case "logical-time-limit":
    case "memory-limit":
    case "output-limit":
    case "filesystem-limit":
    case "wall-time-limit":
      return executionTerminationLabel(locale, verdict);
    case "accepted":
    case "wrong-answer":
    case "runtime-error":
    case "compile-error":
    case "judge-error":
    case "cancelled":
      return verdictLabel(locale, verdict);
  }
}

export function SubmissionList() {
  const { locale, session } = useProduct();
  const text = copy[locale];
  const [submissions, setSubmissions] = useState<readonly SubmissionSummary[]>([]);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<{ readonly before: string; readonly beforeId: string } | null>();
  const [loading, setLoading] = useState(false);
  usePageTitle(locale === "zh-TW" ? "提交紀錄" : "Submissions");
  const loadPage = useCallback(async (cursor?: { readonly before: string; readonly beforeId: string }) => {
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({ limit: "50" });
      if (cursor) {
        parameters.set("before", cursor.before);
        parameters.set("beforeId", cursor.beforeId);
      }
      const value = await forgeJson<{
        submissions: readonly SubmissionSummary[];
        nextCursor: { readonly before: string; readonly beforeId: string } | null;
      }>(`/api/submissions?${parameters}`);
      setSubmissions((current) => cursor ? [...current, ...value.submissions] : value.submissions);
      setNextCursor(value.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = window.setTimeout(() => void loadPage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPage, session?.authenticated]);
  if (session?.authenticated && loading && nextCursor === undefined) return <div className="product-page" id="main-content" role="main"><div className="product-empty large" role="status">{locale === "zh-TW" ? "載入提交紀錄…" : "Loading submissions…"}</div></div>;
  if (session?.authenticated && error && submissions.length === 0) return <div className="product-page" id="main-content" role="main"><div className="product-error" role="alert">{error}<button type="button" onClick={() => void loadPage()}><RefreshCw size={14} /> {locale === "zh-TW" ? "重試" : "Retry"}</button></div></div>;
  return <div className="product-page" id="main-content" role="main"><header className="product-page-header"><span className="product-eyebrow"><ListChecks size={14} /> History</span><h1>{text.submissions}</h1><p>{text.submissionsIntro}</p></header>{!session?.authenticated ? <SignInEmpty returnPath="/submissions" /> : <div className="submission-list">{submissions.map((submission) => {
    const cost = submissionCostPresentation(submission, locale);
    const result = submission.verdict ? submissionVerdictLabel(locale, submission.verdict) : submission.state;
    return <Link href={`/submissions/${submission.id}`} className="submission-row" key={submission.id}><span className={`submission-verdict state-${submission.verdict ?? submission.state}`}>{result}</span><div><strong>{localized(submission.problem?.title, locale, submission.problem?.slug)}</strong><small>{submission.contest?.title ?? "Official practice"} · {submission.language} · {cost.label}: {cost.value}</small></div><span>{submission.score ?? "—"}</span><time>{formatDate(submission.createdAt, locale)}</time><ChevronRight size={16} /></Link>;
  })}{submissions.length === 0 && nextCursor !== undefined && <div className="product-empty large">{text.noSubmissions}</div>}{nextCursor && <button className="secondary-action" type="button" disabled={loading} onClick={() => void loadPage(nextCursor)}>{loading ? (locale === "zh-TW" ? "載入中…" : "Loading…") : (locale === "zh-TW" ? "載入更多" : "Load more")}</button>}</div>}{error && <div className="product-error">{error}</div>}</div>;
}

export function SubmissionDetail({ submissionId }: { readonly submissionId: string }) {
  const { locale } = useProduct();
  const [submission, setSubmission] = useState<SubmissionSummary>();
  const [error, setError] = useState("");
  const [pollingConnection, setPollingConnection] = useState<SubmissionPollingConnectionState>();
  const [pollingError, setPollingError] = useState("");
  const [pollingGeneration, setPollingGeneration] = useState(0);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  usePageTitle(submission ? localized(submission.problem?.title, locale, submission.problem?.slug) : (locale === "zh-TW" ? "提交詳情" : "Submission"));
  const load = useCallback(async () => {
    setError("");
    try {
      const value = await forgeJson<{ submission: SubmissionSummary }>(`/api/submissions/${encodeURIComponent(submissionId)}`);
      setSubmission(value.submission);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [submissionId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const terminal = submission ? isTerminalSubmissionState(submission.state) : true;
  const owner = submission?.owner === true;
  useEffect(() => {
    if (!owner || terminal) return;
    const client = new SubmissionEventPollingClient({
      eventsUrl: new URL(`/api/submissions/${encodeURIComponent(submissionId)}/events`, window.location.origin).toString(),
      onStatus: (status) => {
        setPollingConnection(status.state);
        if (status.state === "error") setPollingError(status.reason ?? "Submission updates stopped.");
      },
      onEvent: (event: SequencedSubmissionEvent) => {
        setSubmission((current) => {
          if (!current) return current;
          if (event.kind === "state" && event.state) return { ...current, state: event.state };
          if (event.kind === "verdict" && event.verdict) return {
            ...current,
            verdict: event.verdict,
            score: event.score ?? current.score,
            fullyPassedCases: event.fullyPassedCases ?? current.fullyPassedCases,
          };
          if (event.kind === "resource-summary") return {
            ...current,
            deterministicCost: event.deterministicCost ?? current.deterministicCost,
            peakMemoryBytes: event.peakMemoryBytes ?? current.peakMemoryBytes,
          };
          return current;
        });
      },
    });
    void client.run().then((result) => {
      if (result.kind === "terminal") void load();
    }).catch((reason: unknown) => setPollingError(reason instanceof Error ? reason.message : String(reason)));
    return () => client.stop("submission detail changed");
  }, [load, owner, pollingGeneration, submissionId, terminal]);
  async function changeVisibility() {
    if (!submission) return;
    setVisibilityBusy(true);
    setError("");
    try {
      const visibility = submission.visibility === "private" ? "public" : "private";
      await forgeMutation(`/api/submissions/${encodeURIComponent(submission.id)}`, { visibility }, "PATCH");
      setSubmission({ ...submission, visibility });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVisibilityBusy(false);
    }
  }
  if (error && !submission) return <div className="product-page" id="main-content" role="main"><div className="product-error" role="alert">{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} /> {locale === "zh-TW" ? "重試" : "Retry"}</button></div></div>;
  if (!submission) return <div className="product-page" id="main-content" role="main"><div className="product-empty large" role="status">Loading submission…</div></div>;
  const cost = submissionCostPresentation(submission, locale);
  const displayedVerdict = submission.verdict ? submissionVerdictLabel(locale, submission.verdict) : submission.state;
  return <main className="product-page" id="main-content"><header className="product-page-header"><Link className="product-back" href="/submissions">← {copy[locale].submissions}</Link><h1>{localized(submission.problem?.title, locale, submission.problem?.slug)}</h1><p>{submission.contest?.title ?? "Official practice"} · {formatDate(submission.createdAt, locale)}</p>{submission.owner && !terminal && <span role="status">{pollingConnection === "reconnecting" ? (locale === "zh-TW" ? "重新連線中…" : "Reconnecting…") : (locale === "zh-TW" ? "判題中，自動更新" : "Judging · updating automatically")}</span>}</header>{error && <div className="product-error">{error}</div>}{pollingError && <div className="product-error">{pollingError}<button type="button" aria-label={locale === "zh-TW" ? "重試取得判題進度" : "Retry submission updates"} onClick={() => { setPollingError(""); setPollingGeneration((current) => current + 1); }}><RefreshCw size={14} /> {locale === "zh-TW" ? "重試" : "Retry"}</button></div>}<div className="submission-detail-grid"><article><span>Verdict</span><strong className={`state-${submission.verdict ?? submission.state}`}>{displayedVerdict}</strong></article><article><span>Score</span><strong>{submission.score ?? "—"}</strong></article><article><span>Language</span><strong>{submission.language}</strong></article><article><span>Passed cases</span><strong>{submission.fullyPassedCases ?? "—"}</strong></article><article><span>{cost.label}</span><strong>{cost.value}</strong></article><article><span>Peak memory</span><strong>{submission.peakMemoryBytes === null ? "—" : `${(submission.peakMemoryBytes / 1_048_576).toFixed(1)} MiB`}</strong></article><article><span>Visibility</span><strong>{submission.visibility}</strong></article></div><div className="detail-actions"><Link className="primary-action" href={submission.contest ? `/contests/${submission.contest.id}/problems/${submission.managedProblemVersionId}` : `/problems/${submission.managedProblemVersionId}`}>Open problem</Link>{submission.sourceAvailable && <a className="secondary-action" href={`/api/submissions/${submission.id}/source`}>View source</a>}{submission.owner && submission.state === "completed" && <button className="secondary-action" type="button" disabled={visibilityBusy} onClick={() => void changeVisibility()}>{submission.visibility === "private" ? <Globe2 size={15} /> : <LockKeyhole size={15} />}{submission.visibility === "private" ? (locale === "zh-TW" ? "設為公開" : "Make public") : (locale === "zh-TW" ? "設為私人" : "Make private")}</button>}</div></main>;
}
