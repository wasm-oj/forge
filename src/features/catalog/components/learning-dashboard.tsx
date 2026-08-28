"use client";

import { ArrowRight, CheckCircle2, ChevronRight, CircleDot, Code2, GitBranch, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useProduct, type ProductLocale } from "../../platform/components/app-shell";
import { wasmOjJson } from "../../platform/api/online-api";
import { usePageTitle } from "../../platform/hooks/page-title";
import { submissionCostPresentation } from "../../submissions/model/submission-cost";
import { hasMatchingLocalSamplesPassed, readLocalSamplesPassed, type LocalSamplesPassedRecord } from "../../../judge/local-practice-progress";
import { listProjects } from "../../../storage/database";
import { copy, draftLink, formatDate, localized, type CatalogCollection, type CatalogProblem, type ContestSummary, type SubmissionSummary, useCatalog } from "../model/education-model";
import { contestCatalogGroup, contestPrimaryWallTime } from "../../contests/model/contest-projection";

function hasCurrentLocalSamplesPassed(records: ReadonlyMap<string, LocalSamplesPassedRecord>, problem: CatalogProblem): boolean {
  return hasMatchingLocalSamplesPassed(records, problem.id, problem.contentDigest);
}

export function SectionHeading({ title, detail, href }: { readonly title: string; readonly detail?: string; readonly href?: string }) {
  return <div className="product-section-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{href && <Link href={href}>View all <ArrowRight size={14} /></Link>}</div>;
}

export function ProblemRow({ problem, collection, locale, localSamplesPassed = false }: { readonly problem: CatalogProblem; readonly collection: CatalogCollection; readonly locale: ProductLocale; readonly localSamplesPassed?: boolean }) {
  return <Link className="problem-row" href={`/problems/${encodeURIComponent(problem.id)}`}>
    <span className={problem.solved ? "problem-status is-solved" : "problem-status"}>{problem.solved ? <CheckCircle2 size={17} /> : <CircleDot size={17} />}</span>
    <span className="problem-number">{String(problem.number).padStart(2, "0")}</span>
    <span className="problem-title-cell"><strong>{localized(problem.title, locale, problem.slug)}</strong><small>{localized(problem.summary, locale, problem.slug)}{localSamplesPassed && <span className="local-samples-label"> · {locale === "zh-TW" ? "本機範例通過" : "Samples passed locally"}</span>}</small></span>
    <span className="difficulty-pill">practice</span>
    <span className="problem-tags"><span>{problem.judgeDigest.slice(0, 10)}</span></span>
    <span className="problem-score">{problem.bestScore ?? (problem.solved ? problem.maximumScore : "—")}</span>
    <ChevronRight size={16} />
    <span className="sr-only">{collection.repository.owner}/{collection.repository.name}</span>
  </Link>;
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="product-empty">{children}</p>;
}

export function LearningDashboard() {
  const { locale, session, sessionStatus } = useProduct();
  usePageTitle(locale === "zh-TW" ? "學習首頁" : "Learning home");
  const text = copy[locale];
  const { collections, loading, error } = useCatalog();
  const [contests, setContests] = useState<readonly ContestSummary[]>([]);
  const [submissions, setSubmissions] = useState<readonly SubmissionSummary[]>([]);
  const [contestRequest, setContestRequest] = useState<"loading" | "ready" | "error">("loading");
  const [submissionRequest, setSubmissionRequest] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [draft, setDraft] = useState<{ readonly id: string; readonly name: string; readonly updatedAt: number }>();
  const [localSamplesPassed] = useState<ReadonlyMap<string, LocalSamplesPassedRecord>>(() => typeof window === "undefined" ? new Map() : readLocalSamplesPassed(window.localStorage));

  const loadContests = useCallback(async () => {
    setContestRequest("loading");
    try {
      const value = await wasmOjJson<{ contests: readonly ContestSummary[] }>("/api/contests?limit=6");
      setContests(value.contests);
      setContestRequest("ready");
    } catch {
      setContestRequest("error");
    }
  }, []);
  const loadSubmissions = useCallback(async () => {
    setSubmissionRequest("loading");
    try {
      const value = await wasmOjJson<{ submissions: readonly SubmissionSummary[] }>("/api/submissions?limit=5");
      setSubmissions(value.submissions);
      setSubmissionRequest("ready");
    } catch {
      setSubmissionRequest("error");
    }
  }, []);

  useEffect(() => {
    void listProjects().then((projects) => setDraft(projects[0])).catch(() => undefined);
    queueMicrotask(() => void loadContests());
  }, [loadContests]);
  useEffect(() => {
    if (session?.authenticated) queueMicrotask(() => void loadSubmissions());
  }, [loadSubmissions, session?.authenticated]);

  const official = collections.find((collection) => collection.official);
  const solved = collections.flatMap((collection) => collection.problems).filter((problem) => problem.solved).length;
  const total = collections.reduce((sum, collection) => sum + collection.problems.length, 0);
  const localPassed = collections.flatMap((collection) => collection.problems).filter((problem) => hasCurrentLocalSamplesPassed(localSamplesPassed, problem)).length;
  const featured = official?.problems.slice(0, 5) ?? [];
  const activeContests = contests.filter((contest) => contestCatalogGroup(contest.phase) !== "ended").slice(0, 3);
  const draftSlug = /^judge-\d+-(.+)$/.exec(draft?.name ?? "")?.[1];
  const draftProblem = draftSlug ? collections.flatMap((collection) => collection.problems).find((problem) => problem.slug === draftSlug) : undefined;
  const storedDraftLink = draft ? draftLink(draft.id) : undefined;
  const draftHref = storedDraftLink && storedDraftLink !== "/collections/custom"
    ? storedDraftLink
    : draftProblem ? `/problems/${draftProblem.id}` : storedDraftLink;

  return <main className="product-page dashboard-page" id="main-content">
    <header className="dashboard-hero">
      <div><span className="product-eyebrow"><Sparkles size={14} /> WASM-OJ learning</span><h1>{text.greeting}</h1><p>{text.subtitle}</p><div className="hero-actions"><Link className="primary-action" href={featured[0] ? `/problems/${featured[0].id}` : "/problems"}>{text.start}<ArrowRight size={16} /></Link>{sessionStatus === "ready" && !session?.authenticated && <a className="secondary-action" href="/api/auth/github?return=/">{text.signIn}<GitBranch size={16} /></a>}</div>{sessionStatus === "ready" && !session?.authenticated && <small>{text.anonymous}</small>}</div>
      <div className="dashboard-progress"><span>{locale === "zh-TW" ? "正式解題進度" : "Verified progress"}</span><strong>{solved}<small> / {total}</small></strong><div><i style={{ width: total > 0 ? `${(solved / total) * 100}%` : "0%" }} /></div><p>{text.solved}</p><p className="dashboard-local-progress">{locale === "zh-TW" ? `${localPassed} 題本機範例通過` : `${localPassed} samples passed locally`}</p></div>
    </header>

    <section className="product-section continue-section">
      <SectionHeading title={text.continue} />
      <Link className="continue-card" href={draftHref ?? (featured[0] ? `/problems/${featured[0].id}` : "/problems")}>
        <span className="continue-icon"><Code2 size={22} /></span><div><strong>{draft?.name ?? text.noDraft}</strong><p>{draft ? formatDate(new Date(draft.updatedAt).toISOString(), locale) : text.officialNote}</p></div><span>{text.open}<ChevronRight size={16} /></span>
      </Link>
    </section>

    <section className="product-section">
      <SectionHeading title={text.official} detail={official ? `${official.repository.owner}/${official.repository.name}` : text.officialNote} href="/problems" />
      {loading && <div className="product-empty">Loading official practice…</div>}
      {error && <div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => window.location.reload()}>{locale === "zh-TW" ? "重新載入" : "Reload"}</button></div>}
      {featured.length > 0 && <div className="problem-list compact">{featured.map((problem) => <ProblemRow key={problem.id} problem={problem} collection={official!} locale={locale} localSamplesPassed={hasCurrentLocalSamplesPassed(localSamplesPassed, problem)} />)}</div>}
    </section>

    <div className="dashboard-columns">
      <section className="product-section"><SectionHeading title={text.contests} detail={text.upcoming} href="/contests" />{contestRequest === "loading" && <Empty>{locale === "zh-TW" ? "正在載入競賽…" : "Loading contests…"}</Empty>}{contestRequest === "error" && <div className="product-error" role="alert"><span>{locale === "zh-TW" ? "無法載入競賽。" : "Could not load contests."}</span><button type="button" onClick={() => void loadContests()}>{locale === "zh-TW" ? "重試" : "Retry"}</button></div>}{contestRequest === "ready" && activeContests.map((contest) => <Link className="dashboard-list-item" key={contest.id} href={`/contests/${contest.id}`}><span className={`contest-dot ${contestCatalogGroup(contest.phase)}`} /><div><strong>{contest.title}</strong><small>{formatDate(contestPrimaryWallTime(contest), locale)} · {contest.phase}</small></div><ChevronRight size={15} /></Link>)}{contestRequest === "ready" && activeContests.length === 0 && <Empty>{locale === "zh-TW" ? "目前沒有進行中或即將開始的競賽。" : "No active contests."}</Empty>}</section>
      <section className="product-section"><SectionHeading title={text.recent} href="/submissions" />{session?.authenticated && submissionRequest === "loading" && <Empty>{locale === "zh-TW" ? "正在載入提交紀錄…" : "Loading submissions…"}</Empty>}{session?.authenticated && submissionRequest === "error" && <div className="product-error" role="alert"><span>{locale === "zh-TW" ? "無法載入提交紀錄。" : "Could not load submissions."}</span><button type="button" onClick={() => void loadSubmissions()}>{locale === "zh-TW" ? "重試" : "Retry"}</button></div>}{session?.authenticated && submissionRequest === "ready" ? submissions.slice(0, 4).map((submission) => {
        const cost = submissionCostPresentation(submission, locale);
        return <Link className="dashboard-list-item" key={submission.id} href={`/submissions/${submission.id}`}><span className={`submission-dot state-${submission.state}`} /><div><strong>{localized(submission.problem?.title, locale, submission.problem?.slug)}</strong><small>{submission.state} · {cost.label}: {cost.value} · {formatDate(submission.createdAt, locale)}</small></div><span>{submission.score ?? "—"}</span></Link>;
      }) : sessionStatus === "ready" && !session?.authenticated ? <Empty>{text.signIn}</Empty> : null}{session?.authenticated && submissionRequest === "ready" && submissions.length === 0 && <Empty>{text.noSubmissions}</Empty>}</section>
    </div>
  </main>;
}
