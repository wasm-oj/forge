"use client";

import { Check, CodeXml, GitBranch, RefreshCw, Send, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { wasmOjCsrfToken, wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";
import { requestWasmOjTurnstileToken } from "../../../turnstile/client";
import type { ContestProjection } from "../../contests/model/contest-projection";
import {
  OrganizerContestOperations,
  type OrganizerParticipantRow,
} from "./organizer-contest-operations";

interface OrganizerApplication { readonly id: string; readonly status: "pending" | "approved" | "rejected"; readonly created_at: string; readonly reviewed_at: string | null; readonly review_note: string | null; }
interface OrganizerStatus { readonly authenticated: boolean; readonly organizer: boolean; readonly access: "signed-out" | "eligible" | "pending" | "rejected" | "revoked" | "active"; readonly application: OrganizerApplication | null; }
interface Repository { readonly github_repository_id: number; readonly owner_login: string; readonly name: string; readonly is_private: number; }
interface Catalog { readonly id: string; readonly github_repository_id: number; readonly active_commit_sha: string | null; readonly owner_login: string; readonly name: string; readonly created_at: string; readonly updated_at: string; }
interface CatalogSync { readonly id: string; readonly catalog_id: string; readonly requested_ref: string; readonly commit_sha: string; readonly state: "queued" | "running" | "succeeded" | "failed"; readonly error_code: string | null; readonly summary: { readonly problemCount: number; readonly contestCount: number } | null; readonly created_at: string; readonly updated_at: string; }
type OrganizerContest = ContestProjection & { readonly problemCount: number; readonly pendingRulesCommit: string | null };
interface ContestProblem { readonly ordinal: number; readonly batch: number; readonly problemId: string; readonly problemSlug: string; readonly problemNumber: number; readonly title: Record<string, string>; readonly availability: "locked" | "open" | "closed"; readonly releaseAfterSeconds: number; readonly submissionClosesAfterSeconds: number; readonly points: number; readonly attemptLimit: number; readonly epochs: { readonly timelineGeneration: number; readonly ruleEpoch: number; readonly problemEpoch: number; readonly contentEpoch: number; readonly judgeEpoch: number }; readonly contentCommit: string; readonly judgeDigest: string; }
interface RejudgeRevision { readonly problemId: string; readonly catalogCommit: string; readonly active: boolean; readonly judgeDigest: string; readonly slug: string; readonly order: number; readonly title: Record<string, string>; readonly repository: { readonly owner: string; readonly name: string }; }
interface RejudgeBatch { readonly id: string; readonly problemId: string; readonly fromCommit: string; readonly toCommit: string; readonly contestId: string | null; readonly status: string; readonly expectedCount: number; readonly completedCount: number; readonly readyCount: number; readonly failedCount: number; readonly failureCode: string | null; readonly cancelRequestedAt: string | null; readonly createdAt: string; }

export const CATALOG_POLL_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function catalogPollDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError("Catalog poll attempt must be a non-negative integer.");
  return CATALOG_POLL_DELAYS_MS[Math.min(attempt, CATALOG_POLL_DELAYS_MS.length - 1)]!;
}

export function isTerminalCatalogSync(state: CatalogSync["state"]): boolean { return state === "succeeded" || state === "failed"; }

export function catalogIssueMessage(code: string | null): string {
  if (!code) return "";
  return ({
    "catalog-contract-invalid": "Repository schema, paths, sizes, digests, redaction, or judge package validation failed.",
    "github-content-unavailable": "GitHub could not serve the exact commit. The active commit was not changed.",
    "catalog-sync-failed": "Repository sync failed. Fix the repository and sync a new exact commit.",
  } as Record<string, string>)[code] ?? code;
}

export function generateContestInviteCode(randomValues: Uint8Array = crypto.getRandomValues(new Uint8Array(24))): string {
  if (randomValues.byteLength < 16) throw new TypeError("Invite-code entropy must contain at least 16 bytes.");
  return Array.from(randomValues, (value) => value.toString(16).padStart(2, "0")).join("");
}

function revisionTitle(revision: RejudgeRevision): string { return revision.title["zh-TW"] ?? revision.title.en ?? revision.slug; }
function initialSearchParameter(name: string): string { return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get(name) ?? ""; }

function useOrganizer() {
  const [status, setStatus] = useState<OrganizerStatus>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setStatus(await wasmOjJson<OrganizerStatus>("/api/organizer/status")); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  useEffect(() => { queueMicrotask(() => void refresh()); }, [refresh]);
  return { status, error, refresh };
}

async function submitApplication(statement: string): Promise<void> {
  const csrf = wasmOjCsrfToken();
  if (!csrf) throw new Error("Sign in again: the CSRF token is missing.");
  const request = async (turnstile?: string) => fetch("/api/organizer/applications", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json", "x-wasm-oj-csrf": csrf, ...(turnstile ? { "x-wasm-oj-turnstile-token": turnstile } : {}) },
    body: JSON.stringify({ statement }),
  });
  let response = await request();
  let value = await response.json() as { error?: { code?: unknown; message?: unknown } };
  if (response.status === 403 && value.error?.code === "turnstile-required") {
    response = await request(await requestWasmOjTurnstileToken("organizer-application"));
    value = await response.json() as typeof value;
  }
  if (!response.ok) throw new Error(typeof value.error?.message === "string" ? value.error.message : `Request failed with HTTP ${response.status}.`);
}

function OrganizerGate({ children }: { readonly children: ReactNode }) {
  const { status, error, refresh } = useOrganizer();
  const [statement, setStatement] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  if (error) return <main className="product-page" id="main-content"><div className="product-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>Retry</button></div></main>;
  if (!status) return <main className="product-page" id="main-content"><div className="product-empty large">Loading Organizer access…</div></main>;
  if (!status.authenticated) return <main className="product-page narrow-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Repository-managed contests</h1><p>Sign in to connect an authorized repository and sync exact commits.</p></header><a className="primary-action" href="/api/auth/github?return=/organizer/repositories">Sign in with GitHub</a></main>;
  if (!status.organizer) return <main className="product-page narrow-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Organizer review</h1><p>Organizer access is reviewed before private repository content becomes available.</p></header>{status.access === "pending" ? <section className="organizer-panel"><h2>Application pending</h2><p>Submitted {new Date(status.application!.created_at).toLocaleString()}.</p></section> : <form className="organizer-panel organizer-product-form" onSubmit={(event) => { event.preventDefault(); setBusy(true); void submitApplication(statement).then(refresh).then(() => setMessage("Application submitted.")).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}><label>How will you use repository-managed contests?<textarea minLength={40} maxLength={4000} required value={statement} onChange={(event) => setStatement(event.target.value)} /></label><button className="primary-action" disabled={busy}>Send for review</button></form>}{message && <output className="product-message">{message}</output>}</main>;
  return <>{children}</>;
}

export function OrganizerRepositories() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 儲存庫" : "Organizer repositories");
  return <OrganizerGate><RepositoriesContent /></OrganizerGate>;
}

function RepositoriesContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [message, setMessage] = useState("");
  const githubResult = initialSearchParameter("github");
  useEffect(() => { void wasmOjJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories").then((value) => setRepositories(value.repositories)).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))); }, []);
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><GitBranch size={14} /> Organizer</span><h1>Repositories</h1><p>Grant the read-only GitHub App access to repositories containing <code>wasm-oj.json</code>.</p></header>{githubResult && <output className={githubResult === "connected" ? "product-message" : "product-error"}>{githubResult === "connected" ? "GitHub repositories connected." : "GitHub connection did not complete."}</output>}<a className="primary-action" href="/api/organizer/github/install">Connect or update repositories</a><section className="organizer-product-section"><h2>Authorized repositories</h2>{repositories.map((repository) => <article className="organizer-resource-row" key={repository.github_repository_id}><GitBranch size={17} /><div><strong>{repository.owner_login}/{repository.name}</strong><span>{repository.is_private ? "Private" : "Public"}</span></div><Check size={16} /></article>)}{repositories.length === 0 && <p className="product-empty">No repositories connected.</p>}</section>{message && <output className="product-message">{message}</output>}</main>;
}

export function OrganizerCatalogs() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 題庫同步" : "Organizer catalog sync");
  return <OrganizerGate><CatalogsContent /></OrganizerGate>;
}

function CatalogsContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [catalogs, setCatalogs] = useState<readonly Catalog[]>([]);
  const [repositoryId, setRepositoryId] = useState(initialSearchParameter("repositoryId"));
  const [catalogId, setCatalogId] = useState("");
  const [ref, setRef] = useState(initialSearchParameter("ref") || "main");
  const [sync, setSync] = useState<CatalogSync>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [repositoryResult, catalogResult] = await Promise.all([
      wasmOjJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"),
      wasmOjJson<{ catalogs: readonly Catalog[] }>("/api/organizer/catalogs"),
    ]);
    setRepositories(repositoryResult.repositories); setCatalogs(catalogResult.catalogs);
    setCatalogId((current) => current || catalogResult.catalogs[0]?.id || "");
  }, []);
  useEffect(() => { queueMicrotask(() => void load().catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason)))); }, [load]);
  useEffect(() => {
    if (!sync || isTerminalCatalogSync(sync.state)) return;
    let cancelled = false; let attempt = 0; let timer: number | undefined;
    const poll = async () => {
      try {
        const value = await wasmOjJson<{ sync: CatalogSync }>(`/api/organizer/catalog-syncs/${encodeURIComponent(sync.id)}`);
        if (cancelled) return;
        setSync(value.sync);
        if (isTerminalCatalogSync(value.sync.state)) { await load(); return; }
        timer = window.setTimeout(() => void poll(), catalogPollDelay(attempt++));
      } catch (reason) { if (!cancelled) setMessage(reason instanceof Error ? reason.message : String(reason)); }
    };
    timer = window.setTimeout(() => void poll(), catalogPollDelay(attempt++));
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [load, sync]);
  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try { const value = await wasmOjMutation<{ catalog: Catalog }>("/api/organizer/catalogs", { githubRepositoryId: Number(repositoryId) }); await load(); setCatalogId(value.catalog.id); setMessage("Repository catalog connected."); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function synchronize(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try { const value = await wasmOjMutation<{ sync: CatalogSync }>(`/api/organizer/catalogs/${encodeURIComponent(catalogId)}/syncs`, { ref, idempotencyKey: crypto.randomUUID() }); setSync(value.sync); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><GitBranch size={14} /> Organizer</span><h1>Repository catalogs</h1><p>Resolve one ref once, validate its exact commit, repair judge objects, then atomically switch the active projection.</p></header><form className="organizer-panel organizer-product-form" onSubmit={(event) => void connect(event)}><h2>Connect repository</h2><label>Authorized repository<select required value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}><option value="">Choose a repository…</option>{repositories.map((repository) => <option key={repository.github_repository_id} value={repository.github_repository_id}>{repository.owner_login}/{repository.name}</option>)}</select></label><button className="primary-action" disabled={busy || !repositoryId}>Connect catalog</button></form><form className="organizer-panel organizer-product-form" onSubmit={(event) => void synchronize(event)}><h2>Sync exact commit</h2><label>Catalog<select required value={catalogId} onChange={(event) => setCatalogId(event.target.value)}><option value="">Choose a catalog…</option>{catalogs.map((catalog) => <option key={catalog.id} value={catalog.id}>{catalog.owner_login}/{catalog.name}</option>)}</select></label><label>Git ref<input required maxLength={256} value={ref} onChange={(event) => setRef(event.target.value)} /></label><button className="primary-action" disabled={busy || !catalogId || !ref}>Sync repository</button></form><section className="organizer-product-section"><h2>Connected catalogs</h2>{catalogs.map((catalog) => <article className="collection-summary" key={catalog.id}><div><strong>{catalog.owner_login}/{catalog.name}</strong><span>{catalog.active_commit_sha ? `Active ${catalog.active_commit_sha}` : "Not synced"}</span><small>Catalog {catalog.id}</small></div></article>)}{catalogs.length === 0 && <p className="product-empty">No repository catalogs connected.</p>}</section>{sync && <section className="organizer-panel"><h2>Sync {sync.state}</h2><p><code>{sync.commit_sha}</code> from <code>{sync.requested_ref}</code></p>{sync.summary && <p>{sync.summary.problemCount} problems · {sync.summary.contestCount} contests</p>}{sync.error_code && <p className="product-error">{catalogIssueMessage(sync.error_code)}</p>}<p><code>woj organizer catalog sync-show {sync.id} --watch</code></p></section>}{message && <output className="product-message">{message}</output>}</main>;
}

export function OrganizerContests() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 競賽" : "Organizer contests");
  return <OrganizerGate><ContestsContent /></OrganizerGate>;
}

function ContestsContent() {
  const [contests, setContests] = useState<readonly OrganizerContest[]>([]);
  const [selected, setSelected] = useState<{ readonly contest: OrganizerContest; readonly problems: readonly ContestProblem[] }>();
  const [participants, setParticipants] = useState<readonly OrganizerParticipantRow[]>([]);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => { const value = await wasmOjJson<{ contests: readonly OrganizerContest[] }>("/api/organizer/contests"); setContests(value.contests); }, []);
  const inspect = useCallback(async (contestId: string) => {
    const [detail, participantResult] = await Promise.all([
      wasmOjJson<{ contest: OrganizerContest; problems: readonly ContestProblem[] }>(`/api/organizer/contests/${encodeURIComponent(contestId)}`),
      wasmOjJson<{ participants: readonly OrganizerParticipantRow[] }>(`/api/organizer/contests/${encodeURIComponent(contestId)}/participants`),
    ]);
    setSelected(detail); setParticipants(participantResult.participants);
  }, []);
  useEffect(() => { queueMicrotask(() => void load().catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason)))); }, [load]);
  async function rotate(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    try { await wasmOjMutation(`/api/organizer/contests/${encodeURIComponent(selected.contest.id)}/invite-code`, { inviteCode }); setInviteCode(""); await load(); await inspect(selected.contest.id); setMessage("Invite credential rotated. Store the supplied code securely; the platform retains only its HMAC."); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <main className="product-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><Trophy size={14} /> Organizer</span><h1>Repository contests</h1><p>Rules remain repository-authored. This surface inspects the active projection and operates its official timeline.</p></header>
    <section className="organizer-product-section">
      <header className="organizer-actions"><h2>Current projection</h2><button type="button" onClick={() => void load()} aria-label="Refresh contests"><RefreshCw size={15} /></button></header>
      {contests.map((contest) => <article className="collection-summary" key={contest.id}><div><span>{contest.status} · {contest.phase} · {contest.runtimeState}</span><strong>{contest.title}</strong><small>{contest.problemCount} problems · rules {contest.rulesCommit.slice(0, 12)} · timeline {contest.epochs.timelineGeneration} / rule {contest.epochs.ruleEpoch}</small></div><div className="organizer-actions"><button type="button" onClick={() => void inspect(contest.id)}>Inspect</button><Link href={`/contests/${contest.id}`}>Participant preview</Link></div></article>)}
      {contests.length === 0 && <p className="product-empty">No contests exist in the active repository manifests.</p>}
    </section>
    {selected && <section className="organizer-panel organizer-contest-inspector">
      <header><div><h2>{selected.contest.title}</h2><p>{selected.contest.description}</p></div><Link href={`/contests/${selected.contest.id}`}>Open participant preview</Link></header>
      {selected.contest.publicRepositoryTimingWarning && <div className="contest-alert warning" role="note"><GitBranch size={17} /><div><strong>Public repository timing warning</strong><p>Scheduled reveal controls the platform UI only. GitHub content may be visible before its logical release.</p></div></div>}
      <section className="organizer-problem-epochs" aria-labelledby="organizer-problem-epochs-heading"><h3 id="organizer-problem-epochs-heading">Problem epochs</h3>{selected.problems.map((problem) => <div className="selected-problem" key={problem.problemId}><span>{problem.ordinal}</span><strong>{problem.title["zh-TW"] ?? problem.title.en ?? problem.problemSlug}</strong><small>batch {problem.batch} · {problem.availability} · problem {problem.epochs.problemEpoch} / content {problem.epochs.contentEpoch} / judge {problem.epochs.judgeEpoch}</small></div>)}</section>
      {selected.contest.accessMode === "invite" && <form className="organizer-product-form organizer-invite-rotation" onSubmit={(event) => void rotate(event)}><label>New invite credential<div className="organizer-actions"><input required minLength={16} maxLength={128} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /><button type="button" onClick={() => setInviteCode(generateContestInviteCode())}>Generate</button></div></label><button className="primary-action">Rotate invite</button></form>}
      <OrganizerContestOperations contest={selected.contest} participants={participants} onRefresh={async () => { await Promise.all([load(), inspect(selected.contest.id)]); }} />
    </section>}
    {message && <output className="product-message">{message}</output>}
  </main>;
}

export function OrganizerRejudges() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 重新判題" : "Organizer rejudges");
  return <OrganizerGate><RejudgesContent /></OrganizerGate>;
}

function RejudgesContent() {
  const [revisions, setRevisions] = useState<readonly RejudgeRevision[]>([]);
  const [targets, setTargets] = useState<readonly RejudgeRevision[]>([]);
  const [history, setHistory] = useState<readonly RejudgeBatch[]>([]);
  const [sourceKey, setSourceKey] = useState("");
  const [toCommit, setToCommit] = useState("");
  const [contestId, setContestId] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [options, batches] = await Promise.all([
      wasmOjJson<{ revisions: readonly RejudgeRevision[] }>("/api/organizer/rejudges/options"),
      wasmOjJson<{ rejudgeBatches: readonly RejudgeBatch[] }>("/api/organizer/rejudges"),
    ]);
    setRevisions(options.revisions); setHistory(batches.rejudgeBatches);
  }, []);
  useEffect(() => { queueMicrotask(() => void load().catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason)))); }, [load]);
  async function chooseSource(value: string) {
    setSourceKey(value); setToCommit(""); setTargets([]);
    if (!value) return;
    const [problemId, fromCommit] = value.split(":");
    const options = await wasmOjJson<{ targets: readonly RejudgeRevision[] }>(`/api/organizer/rejudges/options?problemId=${encodeURIComponent(problemId!)}&fromCommit=${encodeURIComponent(fromCommit!)}`);
    setTargets(options.targets.filter((target) => target.active));
  }
  async function create(event: FormEvent) {
    event.preventDefault(); const [problemId, fromCommit] = sourceKey.split(":");
    try { await wasmOjMutation("/api/organizer/rejudges", { problemId, fromCommit, toCommit, ...(contestId ? { contestId } : {}), idempotencyKey: crypto.randomUUID() }); await load(); setMessage("Rejudge started. Origin submissions remain immutable until the child results become effective."); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function cancel(batchId: string) {
    try { await wasmOjMutation(`/api/organizer/rejudges/${encodeURIComponent(batchId)}/cancel`, {}); await load(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  const revisionLabel = (revision: RejudgeRevision) => `${revision.repository.owner}/${revision.repository.name} · ${revision.order}. ${revisionTitle(revision)} · ${revision.catalogCommit.slice(0, 12)} · judge ${revision.judgeDigest.slice(0, 10)}`;
  return <main className="product-page narrow-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><Send size={14} /> Organizer</span><h1>Manual rejudge</h1><p>Rejudge one stable problem from a historical commit to the current active commit.</p></header><form className="organizer-panel organizer-product-form" onSubmit={(event) => void create(event)}><label>Source revision<select required value={sourceKey} onChange={(event) => void chooseSource(event.target.value)}><option value="">Choose a problem commit…</option>{revisions.filter((revision) => !revision.active).map((revision) => <option key={`${revision.problemId}:${revision.catalogCommit}`} value={`${revision.problemId}:${revision.catalogCommit}`}>{revisionLabel(revision)}</option>)}</select></label><label>Active target<select required disabled={!sourceKey} value={toCommit} onChange={(event) => setToCommit(event.target.value)}><option value="">Choose active commit…</option>{targets.map((revision) => <option key={revision.catalogCommit} value={revision.catalogCommit}>{revisionLabel(revision)}</option>)}</select></label><label>Contest ID (optional)<input value={contestId} onChange={(event) => setContestId(event.target.value)} /></label><button className="primary-action" disabled={!sourceKey || !toCommit}>Start rejudge</button></form><section className="organizer-product-section"><header className="organizer-actions"><h2>History</h2><button type="button" onClick={() => void load()} aria-label="Refresh rejudges"><RefreshCw size={15} /></button></header>{history.map((batch) => <article className="collection-summary" key={batch.id}><div><span>{batch.status} · {new Date(batch.createdAt).toLocaleString()}</span><strong>{batch.problemId}</strong><small>{batch.fromCommit.slice(0, 12)} → {batch.toCommit.slice(0, 12)}</small><small>{batch.completedCount}/{batch.expectedCount} complete · {batch.readyCount} ready · {batch.failedCount} failed</small>{batch.failureCode && <small>{batch.failureCode}</small>}</div>{["queued", "running", "ready"].includes(batch.status) && batch.cancelRequestedAt === null && <button type="button" onClick={() => void cancel(batch.id)}>Cancel</button>}</article>)}{history.length === 0 && <p className="product-empty">No rejudge history.</p>}</section>{message && <output className="product-message">{message}</output>}</main>;
}
