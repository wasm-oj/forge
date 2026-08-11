"use client";

import { ArrowRight, CheckCircle2, ChevronRight, CircleDot, Code2, GitBranch, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useProduct, type ProductLocale } from "./app-shell";
import { copy, draftLink, formatDate, localized, type CatalogCollection, type CatalogProblem, type ContestSummary, type SubmissionSummary, useCatalog } from "./education-model";
import { forgeJson } from "./online-api";
import { listProjects } from "../storage/database";

export function SectionHeading({ title, detail, href }: { readonly title: string; readonly detail?: string; readonly href?: string }) {
  return <div className="product-section-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{href && <Link href={href}>View all <ArrowRight size={14} /></Link>}</div>;
}

export function ProblemRow({ problem, collection, locale }: { readonly problem: CatalogProblem; readonly collection: CatalogCollection; readonly locale: ProductLocale }) {
  return <Link className="problem-row" href={`/problems/${encodeURIComponent(problem.id)}`}>
    <span className={problem.solved ? "problem-status is-solved" : "problem-status"}>{problem.solved ? <CheckCircle2 size={17} /> : <CircleDot size={17} />}</span>
    <span className="problem-number">{String(problem.number).padStart(2, "0")}</span>
    <span className="problem-title-cell"><strong>{localized(problem.title, locale, problem.slug)}</strong><small>{localized(problem.track, locale, problem.trackId)}</small></span>
    <span className={`difficulty-pill difficulty-${problem.difficulty}`}>{problem.difficulty}</span>
    <span className="problem-tags">{problem.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</span>
    <span className="problem-score">{problem.bestScore ?? (problem.solved ? problem.maximumScore : "—")}</span>
    <ChevronRight size={16} />
    <span className="sr-only">{collection.repository.owner}/{collection.repository.name}</span>
  </Link>;
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="product-empty">{children}</p>;
}

export function LearningDashboard() {
  const { locale, session } = useProduct();
  const text = copy[locale];
  const { collections, loading, error } = useCatalog();
  const [contests, setContests] = useState<readonly ContestSummary[]>([]);
  const [submissions, setSubmissions] = useState<readonly SubmissionSummary[]>([]);
  const [draft, setDraft] = useState<{ readonly id: string; readonly name: string; readonly updatedAt: number }>();

  useEffect(() => {
    void listProjects().then((projects) => setDraft(projects[0])).catch(() => undefined);
    void forgeJson<{ contests: readonly ContestSummary[] }>("/api/contests?limit=6").then((value) => setContests(value.contests)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (session?.authenticated) void forgeJson<{ submissions: readonly SubmissionSummary[] }>("/api/submissions?limit=5").then((value) => setSubmissions(value.submissions)).catch(() => undefined);
  }, [session?.authenticated]);

  const official = collections.find((collection) => collection.official);
  const solved = collections.flatMap((collection) => collection.problems).filter((problem) => problem.solved).length;
  const total = collections.reduce((sum, collection) => sum + collection.problems.length, 0);
  const featured = official?.problems.slice(0, 5) ?? [];
  const activeContests = contests.filter((contest) => contest.phase !== "ended").slice(0, 3);
  const draftSlug = /^judge-\d+-(.+)$/.exec(draft?.name ?? "")?.[1];
  const draftProblem = draftSlug ? collections.flatMap((collection) => collection.problems).find((problem) => problem.slug === draftSlug) : undefined;
  const storedDraftLink = draft ? draftLink(draft.id) : undefined;
  const draftHref = storedDraftLink && storedDraftLink !== "/collections/custom"
    ? storedDraftLink
    : draftProblem ? `/problems/${draftProblem.id}` : storedDraftLink;

  return <main className="product-page dashboard-page" id="main-content">
    <header className="dashboard-hero">
      <div><span className="product-eyebrow"><Sparkles size={14} /> Forge learning</span><h1>{text.greeting}</h1><p>{text.subtitle}</p><div className="hero-actions"><Link className="primary-action" href={featured[0] ? `/problems/${featured[0].id}` : "/problems"}>{text.start}<ArrowRight size={16} /></Link>{!session?.authenticated && <a className="secondary-action" href="/api/auth/github?return=/">{text.signIn}<GitBranch size={16} /></a>}</div>{!session?.authenticated && <small>{text.anonymous}</small>}</div>
      <div className="dashboard-progress"><span>{text.progress}</span><strong>{solved}<small> / {total}</small></strong><div><i style={{ width: total > 0 ? `${(solved / total) * 100}%` : "0%" }} /></div><p>{text.solved}</p></div>
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
      {error && <div className="product-error">{error}</div>}
      {featured.length > 0 && <div className="problem-list compact">{featured.map((problem) => <ProblemRow key={problem.id} problem={problem} collection={official!} locale={locale} />)}</div>}
    </section>

    <div className="dashboard-columns">
      <section className="product-section"><SectionHeading title={text.contests} detail={text.upcoming} href="/contests" />{activeContests.map((contest) => <Link className="dashboard-list-item" key={contest.id} href={`/contests/${contest.id}`}><span className={`contest-dot ${contest.phase}`} /><div><strong>{contest.title}</strong><small>{formatDate(contest.startsAt, locale)}</small></div><ChevronRight size={15} /></Link>)}{activeContests.length === 0 && <Empty>No active contests.</Empty>}</section>
      <section className="product-section"><SectionHeading title={text.recent} href="/submissions" />{session?.authenticated ? submissions.slice(0, 4).map((submission) => <Link className="dashboard-list-item" key={submission.id} href={`/submissions/${submission.id}`}><span className={`submission-dot state-${submission.state}`} /><div><strong>{localized(submission.problem?.title, locale, submission.problem?.slug)}</strong><small>{submission.state} · {formatDate(submission.createdAt, locale)}</small></div><span>{submission.score ?? "—"}</span></Link>) : <Empty>{text.signIn}</Empty>}{session?.authenticated && submissions.length === 0 && <Empty>{text.noSubmissions}</Empty>}</section>
    </div>
  </main>;
}
