"use client";

import { ArrowDown, ArrowUp, Check, ChevronRight, CircleAlert, CodeXml, Copy, Eye, GitBranch, LoaderCircle, RefreshCw, Search, Send, Trophy, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { requestForgeTurnstileToken } from "../turnstile/client";
import { useProduct } from "./app-shell";
import { Drawer } from "./drawer";
import { IconButton } from "./icon-button";
import { csrfToken, forgeJson } from "./online-api";
import { usePageTitle } from "./page-title";

interface OrganizerApplication { readonly id: string; readonly status: "pending" | "approved" | "rejected"; readonly created_at: string; readonly reviewed_at: string | null; readonly review_note: string | null; }
interface OrganizerStatus { readonly authenticated: boolean; readonly organizer: boolean; readonly access: "signed-out" | "eligible" | "pending" | "rejected" | "revoked" | "active"; readonly application: OrganizerApplication | null; }
interface Repository { readonly github_repository_id: number; readonly owner_login: string; readonly name: string; readonly is_private: number; }
interface PushNotice { readonly id: string; readonly githubRepositoryId: number; readonly repository: string; readonly private: boolean; readonly commitSha: string; readonly ref: string; readonly receivedAt: string; readonly acknowledgedAt: string | null; }
interface OrganizerImport { readonly id: string; readonly requested_ref: string; readonly commit_sha: string; readonly index_path: string; readonly retry_of_import_id: string | null; readonly status: string; readonly error_code: string | null; readonly created_at: string; readonly updated_at: string; readonly repository_name: string; readonly owner_login: string; }
interface OrganizerProblem { readonly id: string; readonly slug: string; readonly number: number; readonly title: Record<string, string>; readonly difficulty: string | null; readonly tags: readonly string[]; }
interface OrganizerCollection { readonly snapshotId: string; readonly importId: string; readonly mode: "official-practice" | "contest"; readonly revision: string; readonly status: string; readonly publishedAt: string | null; readonly repository: { readonly id: number; readonly owner: string; readonly name: string }; readonly problems: readonly OrganizerProblem[]; }
interface CollectionResult { readonly imports: readonly OrganizerImport[]; readonly collections: readonly OrganizerCollection[]; }
interface ImportReview {
  readonly collectionRevision: string;
  readonly problemCount: number;
  readonly checks: readonly string[];
  readonly problems: readonly { readonly slug: string; readonly number: number; readonly title: Record<string, string>; readonly difficulty: string; readonly tags: readonly string[]; readonly bundleDigest: string; readonly allowedLanguages: readonly string[] }[];
  readonly officialPracticeSupersedes: readonly { readonly snapshotId: string; readonly collectionRevision: string; readonly publishedAt: string | null }[];
}
interface ImportDetail { readonly import: OrganizerImport; readonly review: ImportReview | null; }
interface OrganizerContestSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly accessMode: "public" | "invite";
  readonly inviteCodeConfigured: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly freezeAt: string | null;
  readonly status: "draft" | "published" | "archived";
  readonly phase: "upcoming" | "running" | "ended";
  readonly problemCount: number;
  readonly updatedAt: string;
}
interface OrganizerContestDetail {
  readonly contest: OrganizerContestSummary;
  readonly problems: readonly { readonly ordinal: number; readonly problemVersionId: string; readonly problemSlug: string; readonly problemNumber: number; readonly title: Record<string, string>; readonly collectionRevision: string; readonly repository: string }[];
}
interface RejudgeVersionOption {
  readonly problemVersionId: string;
  readonly slug: string;
  readonly number: number;
  readonly title: Record<string, string>;
  readonly collectionRevision: string;
  readonly mode: "official-practice" | "contest";
  readonly publishedAt: string | null;
  readonly repository: { readonly owner: string; readonly name: string };
}
interface RejudgeBatch {
  readonly id: string;
  readonly status: string;
  readonly expectedCount: number;
  readonly completedCount: number;
  readonly readyCount: number;
  readonly failedCount: number;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly effectiveAt: string | null;
  readonly cancellable: boolean;
  readonly repository: string;
  readonly oldProblem: { readonly problemVersionId: string; readonly slug: string; readonly number: number; readonly title: Record<string, string>; readonly collectionRevision: string };
  readonly newProblem: { readonly problemVersionId: string; readonly slug: string; readonly number: number; readonly title: Record<string, string>; readonly collectionRevision: string };
}

export function collectionPublicationMessage(value: unknown, mode: "official-practice" | "contest"): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Collection publication response must be an object.");
  const result = value as Record<string, unknown>;
  if (typeof result.snapshotId !== "string" || typeof result.replayed !== "boolean" || result.status !== "published") {
    throw new TypeError("Collection publication response is invalid.");
  }
  if (result.replayed) return `Collection was already published as ${mode}.`;
  if (!Array.isArray(result.problems)) throw new TypeError("New collection publication is missing its problems.");
  return `Published ${result.problems.length} problems as ${mode}.`;
}

export function collectionImportIssueMessage(code: string | null): string {
  if (!code) return "";
  return ({
    "validation-workflow-errored": "The format-check service stopped unexpectedly. You can retry this exact commit.",
    "validation-workflow-terminated": "The format check was interrupted. You can retry this exact commit.",
    "validation-workflow-delivery-exhausted": "The format check could not start. You can retry this exact commit.",
    "canonical-draft-expired": "This verified draft expired before publication. Import the commit again.",
    "validation-failed": "The collection format or judge packaging is invalid. Fix it in the repository and import a new commit.",
    "validation-input-rejected": "The collection format or judge packaging is invalid. Fix it in the repository and import a new commit.",
  } as Record<string, string>)[code] ?? code;
}

export function generateContestInviteCode(randomValues: Uint8Array = crypto.getRandomValues(new Uint8Array(24))): string {
  if (randomValues.byteLength < 16) throw new TypeError("Invite-code entropy must contain at least 16 bytes.");
  return Array.from(randomValues, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function contestDatetimeLocalValue(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new TypeError("Contest timestamp is invalid.");
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function contestInviteNeedsSaveConfirmation(
  invite: { readonly contestId: string; readonly acknowledged: boolean } | undefined,
  contestId: string,
): boolean {
  return invite?.contestId === contestId && !invite.acknowledged;
}

function problemTitle(problem: { readonly slug: string; readonly title: Record<string, string> }): string {
  return problem.title["zh-TW"] ?? problem.title.en ?? problem.slug;
}

function initialSearchParameter(name: string, fallback = ""): string {
  return typeof window === "undefined" ? fallback : new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function post<T>(path: string, body: unknown): Promise<T> {
  const csrf = csrfToken();
  if (!csrf) return Promise.reject(new Error("Sign in again: the CSRF token is missing."));
  return forgeJson<T>(path, { method: "POST", headers: { "content-type": "application/json", "x-forge-csrf": csrf }, body: JSON.stringify(body) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  const csrf = csrfToken();
  if (!csrf) return Promise.reject(new Error("Sign in again: the CSRF token is missing."));
  return forgeJson<T>(path, { method: "PUT", headers: { "content-type": "application/json", "x-forge-csrf": csrf }, body: JSON.stringify(body) });
}

function useOrganizer() {
  const [status, setStatus] = useState<OrganizerStatus>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setStatus(await forgeJson<OrganizerStatus>("/api/organizer/status")); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  useEffect(() => {
    let active = true;
    void forgeJson<OrganizerStatus>("/api/organizer/status")
      .then((value) => { if (active) setStatus(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  return { status, error, refresh };
}

async function submitApplication(statement: string): Promise<void> {
  const csrf = csrfToken();
  if (!csrf) throw new Error("Sign in again: the CSRF token is missing.");
  const request = async (turnstile?: string) => fetch("/api/organizer/applications", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json", "x-forge-csrf": csrf, ...(turnstile ? { "x-forge-turnstile-token": turnstile } : {}) }, body: JSON.stringify({ statement }) });
  let response = await request();
  let value = await response.json() as { error?: { code?: unknown; message?: unknown } };
  if (response.status === 403 && value.error?.code === "turnstile-required") {
    response = await request(await requestForgeTurnstileToken("organizer-application"));
    value = await response.json() as typeof value;
  }
  if (!response.ok) throw new Error(typeof value.error?.message === "string" ? value.error.message : `Request failed with HTTP ${response.status}.`);
}

function OrganizerGate({ children }: { readonly children: ReactNode }) {
  const { status, error, refresh } = useOrganizer();
  const [statement, setStatement] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  if (error) return <main className="product-page" id="main-content"><div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div></main>;
  if (!status) return <main className="product-page" id="main-content"><div className="product-empty large">Loading Organizer access…</div></main>;
  if (!status.authenticated) return <main className="product-page narrow-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Publish learning material</h1><p>Connect a reviewed Organizer account to import and publish collections.</p></header><a className="primary-action" href="/api/auth/github?return=/organizer/repositories">Sign in with GitHub</a></main>;
  if (!status.organizer) return <main className="product-page narrow-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><CircleAlert size={14} /> Organizer</span><h1>Organizer review</h1><p>Organizer access is reviewed before private repositories or publishing controls become available.</p></header>{status.access === "pending" ? <section className="organizer-panel"><h2>Application pending</h2><p>Submitted {new Date(status.application!.created_at).toLocaleString()}.</p><button type="button" title="Refresh application status" aria-label="Refresh application status" onClick={() => void refresh()}><RefreshCw size={15} /></button></section> : <>{(status.access === "rejected" || status.access === "revoked") && <section className="organizer-panel"><h2>{status.access === "revoked" ? "Organizer access was revoked" : "Application was not approved"}</h2>{status.application?.reviewed_at && <p>Reviewed {new Date(status.application.reviewed_at).toLocaleString()}.</p>}{status.application?.review_note && <p>{status.application.review_note}</p>}</section>}<form className="organizer-panel organizer-product-form" onSubmit={(event) => { event.preventDefault(); setBusy(true); setMessage(""); void submitApplication(statement).then(refresh).then(() => setMessage("Application submitted.")).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}><h2>{status.access === "eligible" ? "Apply for Organizer access" : "Apply again"}</h2><label>How will you use managed collections?<textarea minLength={40} maxLength={4000} required value={statement} onChange={(event) => setStatement(event.target.value)} /></label><button className="primary-action" disabled={busy}>Send for review</button></form></>}{message && <output className="product-message">{message}</output>}</main>;
  return <>{children}</>;
}

export function OrganizerRepositories() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 儲存庫" : "Organizer repositories");
  return <OrganizerGate><RepositoriesContent /></OrganizerGate>;
}

function RepositoriesContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [notices, setNotices] = useState<readonly PushNotice[]>([]);
  const [message, setMessage] = useState("");
  const [githubResult] = useState(() => initialSearchParameter("github"));
  const load = useCallback(async () => {
    const [repositoryResult, noticeResult] = await Promise.all([forgeJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"), forgeJson<{ notices: readonly PushNotice[] }>("/api/organizer/notices")]);
    setRepositories(repositoryResult.repositories); setNotices(noticeResult.notices);
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([forgeJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"), forgeJson<{ notices: readonly PushNotice[] }>("/api/organizer/notices")])
      .then(([repositoryResult, noticeResult]) => { if (active) { setRepositories(repositoryResult.repositories); setNotices(noticeResult.notices); } })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  async function acknowledge(id: string) { try { await post(`/api/organizer/notices/${encodeURIComponent(id)}/acknowledge`, {}); await load(); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } }
  const githubMessage = githubResult === "connected"
    ? "GitHub repositories connected."
    : githubResult
      ? ({
        "sign-in-required": "Sign in again before connecting GitHub repositories.",
        "invalid-callback": "GitHub did not return a valid installation. Try connecting again.",
        "account-mismatch": "The selected GitHub installation belongs to a different account.",
        "installation-suspended": "This GitHub App installation is suspended.",
        "repository-limit": "Forge supports up to 100 repositories in one installation.",
        "github-unavailable": "GitHub could not complete the connection. Try again.",
      } as Record<string, string>)[githubResult] ?? "GitHub could not complete the connection."
      : "";
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><GitBranch size={14} /> Organizer</span><h1>Repositories</h1><p>Connect the read-only GitHub App to the repositories that contain your Forge collections.</p></header>{githubMessage && <output className={githubResult === "connected" ? "product-message" : "product-error"}>{githubMessage}</output>}<a className="primary-action" href="/api/organizer/github/install">Connect or update repositories</a><section className="organizer-product-section"><h2>Connected repositories</h2>{repositories.map((repository) => <article className="organizer-resource-row" key={repository.github_repository_id}><GitBranch size={17} /><div><strong>{repository.owner_login}/{repository.name}</strong><span>{repository.is_private ? "Private" : "Public"}</span></div><Check size={16} /></article>)}{repositories.length === 0 && <p className="product-empty">No repositories connected. Connect the GitHub App to continue.</p>}</section><section className="organizer-product-section"><h2>Repository updates</h2>{notices.filter((notice) => !notice.acknowledgedAt).map((notice) => <article className="organizer-resource-row" key={notice.id}><CircleAlert size={17} /><div><strong>{notice.repository}</strong><span>{notice.ref} · {notice.commitSha.slice(0, 10)} · {new Date(notice.receivedAt).toLocaleString()}</span></div><div className="organizer-actions"><Link href={`/organizer/collections?repositoryId=${notice.githubRepositoryId}&ref=${encodeURIComponent(notice.commitSha)}`}>Import commit</Link><button type="button" onClick={() => void acknowledge(notice.id)}>Dismiss</button></div></article>)}{notices.every((notice) => notice.acknowledgedAt) && <p className="product-empty">No new repository updates.</p>}</section>{message && <output className="product-message">{message}</output>}</main>;
}

export function OrganizerCollections() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 題庫" : "Organizer collections");
  return <OrganizerGate><CollectionsContent /></OrganizerGate>;
}

function CollectionsContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [data, setData] = useState<CollectionResult>({ imports: [], collections: [] });
  const [repositoryId, setRepositoryId] = useState(() => initialSearchParameter("repositoryId"));
  const [ref, setRef] = useState(() => initialSearchParameter("ref", "main"));
  const [indexPath, setIndexPath] = useState("collection/index.json");
  const [selectedImportId, setSelectedImportId] = useState("");
  const [reviewState, setReviewState] = useState<{ readonly importId: string; readonly review: ImportReview | null }>();
  const [publishMode, setPublishMode] = useState<"official-practice" | "contest">();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const publishReturnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const [repositoryResult, collectionResult] = await Promise.all([forgeJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"), forgeJson<CollectionResult>("/api/organizer/collections")]);
    setRepositories(repositoryResult.repositories); setData(collectionResult);
    setRepositoryId((current) => current || String(repositoryResult.repositories[0]?.github_repository_id ?? ""));
    setSelectedImportId((current) => current || collectionResult.imports[0]?.id || "");
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([forgeJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"), forgeJson<CollectionResult>("/api/organizer/collections")])
      .then(([repositoryResult, collectionResult]) => {
        if (!active) return;
        setRepositories(repositoryResult.repositories);
        setData(collectionResult);
        setRepositoryId((current) => current || String(repositoryResult.repositories[0]?.github_repository_id ?? ""));
        setSelectedImportId((current) => current || collectionResult.imports[0]?.id || "");
      })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  const selectedImport = data.imports.find((item) => item.id === selectedImportId);
  const review = selectedImport && reviewState?.importId === selectedImport.id ? reviewState.review : null;

  useEffect(() => {
    if (!selectedImport || ["valid", "invalid", "infrastructure-error"].includes(selectedImport.status)) return;
    const timer = window.setInterval(() => void load().catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))), 2_000);
    return () => window.clearInterval(timer);
  }, [load, selectedImport]);

  useEffect(() => {
    let active = true;
    if (!selectedImport || selectedImport.status !== "valid") {
      return () => { active = false; };
    }
    void forgeJson<ImportDetail>(`/api/organizer/imports/${encodeURIComponent(selectedImport.id)}`)
      .then((result) => { if (active) setReviewState({ importId: selectedImport.id, review: result.review }); })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [selectedImport]);

  async function createImport(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await post<{ importId: string; commitSha: string; status: string }>("/api/organizer/imports", { githubRepositoryId: Number(repositoryId), ref, indexPath });
      setSelectedImportId(result.importId); await load(); setMessage(`Resolved ${result.commitSha.slice(0, 12)}. Format check is ${result.status}.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function publish() {
    if (!selectedImport || !publishMode) return;
    const mode = publishMode;
    setBusy(true); setMessage("");
    try { const result = await post<unknown>(`/api/organizer/imports/${encodeURIComponent(selectedImport.id)}/publish`, { mode }); const publicationMessage = collectionPublicationMessage(result, mode); setPublishMode(undefined); await load(); setMessage(publicationMessage); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function retry() {
    if (!selectedImport || selectedImport.status !== "infrastructure-error") return;
    setBusy(true); setMessage("");
    try {
      const result = await post<{ importId: string; status: string }>(`/api/organizer/imports/${encodeURIComponent(selectedImport.id)}/retry`, {});
      setSelectedImportId(result.importId);
      await load();
      setMessage(`Retry started. Format check is ${result.status}.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const step = !selectedImport ? 1 : selectedImport.status === "valid" ? 3 : ["invalid", "infrastructure-error"].includes(selectedImport.status) ? 2 : 2;
  const publicationWarning = publishMode === "official-practice" && review?.officialPracticeSupersedes.length
    ? `Publishing will supersede ${review.officialPracticeSupersedes.length} current practice collection${review.officialPracticeSupersedes.length === 1 ? "" : "s"}.`
    : `Publish this verified commit as ${publishMode === "contest" ? "contest material" : "public practice"}?`;
  return <><main className="product-page" id="main-content" data-drawer-background>
    <header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Collections</h1><p>Import one exact Git commit, check its format and packaging, review the result, then publish.</p></header>
    <div className="wizard-steps">{["Repository", "Format check", "Review", "Publish"].map((label, index) => <span className={index + 1 <= step + (selectedImport?.status === "valid" ? 1 : 0) ? "is-active" : ""} key={label}><i>{index + 1}</i>{label}</span>)}</div>
    <div className="organizer-split">
      <form className="organizer-panel organizer-product-form" onSubmit={(event) => void createImport(event)}>
        <h2>1. Choose source</h2>
        {repositories.length === 0 && <p className="product-empty">Connect a repository before importing. <Link href="/organizer/repositories">Open repositories</Link></p>}
        <label>Repository<select required value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>{repositories.map((repository) => <option key={repository.github_repository_id} value={repository.github_repository_id}>{repository.owner_login}/{repository.name}{repository.is_private ? " · private" : ""}</option>)}</select></label>
        <label>Branch, tag, or exact commit<input required value={ref} onChange={(event) => setRef(event.target.value)} /></label>
        <label>Collection index<input required value={indexPath} onChange={(event) => setIndexPath(event.target.value)} /></label>
        <button className="primary-action" disabled={busy || !repositoryId}>Check collection</button>
      </form>
      <section className="organizer-panel">
        <h2>2–4. Review and publish</h2>
        <label className="organizer-select-label">Import<select value={selectedImportId} onChange={(event) => setSelectedImportId(event.target.value)}>{data.imports.map((item) => <option key={item.id} value={item.id}>{item.owner_login}/{item.repository_name} · {item.commit_sha.slice(0, 8)} · {item.status}</option>)}</select></label>
        {selectedImport ? <div className="import-result">
          <span className={`import-state state-${selectedImport.status}`}>{selectedImport.status.includes("ing") || selectedImport.status === "queued" ? <LoaderCircle size={14} className="spin" /> : selectedImport.status === "valid" ? <Check size={14} /> : <CircleAlert size={14} />}{selectedImport.status}</span>
          <dl><dt>Repository</dt><dd>{selectedImport.owner_login}/{selectedImport.repository_name}</dd><dt>Commit</dt><dd><code>{selectedImport.commit_sha}</code></dd><dt>Index</dt><dd>{selectedImport.index_path}</dd>{selectedImport.error_code && <><dt>Issue</dt><dd>{collectionImportIssueMessage(selectedImport.error_code)}</dd></>}</dl>
          {selectedImport.status === "infrastructure-error" && <button type="button" title="Retry format check" aria-label="Retry format check" disabled={busy} onClick={() => void retry()}><RefreshCw size={16} /></button>}
          {review && <div className="collection-summary"><div><span>Verified format and judge packaging</span><strong>{review.problemCount} problems</strong><small>Revision {review.collectionRevision.slice(0, 12)} · {review.checks.join(" · ")}</small></div><div>{review.problems.map((problem) => <span key={problem.slug}>{problem.number}. {problem.title["zh-TW"] ?? problem.title.en ?? problem.slug} · {problem.difficulty} · {problem.allowedLanguages.join(", ")}</span>)}</div>{review.officialPracticeSupersedes.length > 0 && <p><CircleAlert size={14} /> Publishing as practice supersedes {review.officialPracticeSupersedes.length} current snapshot.</p>}</div>}
          <div className="organizer-actions"><button className="primary-action" type="button" disabled={busy || selectedImport.status !== "valid" || !review} onClick={(event) => { publishReturnRef.current = event.currentTarget; setMessage(""); setPublishMode("official-practice"); }}>Publish practice</button><button className="secondary-action" type="button" disabled={busy || selectedImport.status !== "valid" || !review} onClick={(event) => { publishReturnRef.current = event.currentTarget; setMessage(""); setPublishMode("contest"); }}>Publish for contest</button></div>
        </div> : <p className="product-empty">Start an import to see its result here.</p>}
      </section>
    </div>
    <section className="organizer-product-section"><h2>Published collections</h2>{data.collections.map((collection) => <article className="collection-summary" key={collection.snapshotId}><div><span>{collection.mode} · {collection.status}</span><strong>{collection.repository.owner}/{collection.repository.name}</strong><small>{collection.problems.length} problems</small></div><div>{collection.problems.slice(0, 4).map((problem) => <span key={problem.id}>{problem.number}. {problem.title["zh-TW"] ?? problem.title.en ?? problem.slug}</span>)}</div></article>)}{data.collections.length === 0 && <p className="product-empty">No published collections yet.</p>}</section>
    {message && <output className="product-message">{message}</output>}
  </main><Drawer open={Boolean(publishMode)} label="Publish collection" onClose={() => { if (!busy) setPublishMode(undefined); }} returnFocusRef={publishReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> Organizer confirmation</span><h2>{publishMode === "contest" ? "Publish contest material" : "Publish public practice"}</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={() => setPublishMode(undefined)} /></header><p>{publicationWarning}</p>{selectedImport && <p>Commit <code>{selectedImport.commit_sha.slice(0, 12)}</code> passed the collection format and judge packaging checks.</p>}{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={() => setPublishMode(undefined)}>Cancel</button><button type="button" className="primary-action" disabled={busy} onClick={() => void publish()}>{publishMode === "contest" ? "Publish for contest" : "Publish practice"}</button></footer></div></Drawer></>;
}

function useOrganizerCollections() {
  const [data, setData] = useState<CollectionResult>({ imports: [], collections: [] });
  const [error, setError] = useState("");
  const refresh = useCallback(async () => setData(await forgeJson<CollectionResult>("/api/organizer/collections")), []);
  useEffect(() => {
    let active = true;
    void forgeJson<CollectionResult>("/api/organizer/collections")
      .then((value) => { if (active) setData(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  return { data, error, refresh };
}

export function OrganizerContests() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 競賽" : "Organizer contests");
  return <OrganizerGate><ContestsContent /></OrganizerGate>;
}

function ContestsContent() {
  const { data, error } = useOrganizerCollections();
  const problems = useMemo(() => data.collections.filter((collection) => collection.mode === "contest" && collection.status === "published").flatMap((collection) => collection.problems.map((problem) => ({ ...problem, collection: `${collection.repository.owner}/${collection.repository.name}` }))), [data.collections]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [accessMode, setAccessMode] = useState<"public" | "invite">("public"); const [inviteCode, setInviteCode] = useState(""); const [startsAt, setStartsAt] = useState(""); const [endsAt, setEndsAt] = useState(""); const [freezeAt, setFreezeAt] = useState("");
  const [contests, setContests] = useState<readonly OrganizerContestSummary[]>([]);
  const [detail, setDetail] = useState<OrganizerContestDetail>();
  const [editingId, setEditingId] = useState("");
  const [freshInvite, setFreshInvite] = useState<{ readonly contestId: string; readonly code: string; readonly savedConfirmed: boolean; readonly acknowledged: boolean }>();
  const [contestConfirmation, setContestConfirmation] = useState<{ readonly type: "publish" | "rotate-invite"; readonly contest: OrganizerContestSummary }>();
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const contestConfirmationReturnRef = useRef<HTMLButtonElement>(null);
  const inviteReturnRef = useRef<HTMLButtonElement>(null);
  const draftSaveReturnRef = useRef<HTMLButtonElement>(null);
  const filtered = problems.filter((problem) => `${problem.number} ${problem.slug} ${Object.values(problem.title).join(" ")} ${problem.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const loadContests = useCallback(async () => {
    const result = await forgeJson<{ contests: readonly OrganizerContestSummary[] }>("/api/organizer/contests");
    setContests(result.contests);
  }, []);
  useEffect(() => {
    let active = true;
    void forgeJson<{ contests: readonly OrganizerContestSummary[] }>("/api/organizer/contests")
      .then((result) => { if (active) setContests(result.contests); })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!freshInvite || freshInvite.acknowledged) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [freshInvite]);
  function toggle(id: string) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function move(index: number, direction: -1 | 1) { setSelected((current) => { const next = [...current]; const other = index + direction; if (other < 0 || other >= next.length) return current; [next[index], next[other]] = [next[other], next[index]]; return next; }); }
  async function openDetail(contestId: string) {
    try { setDetail(await forgeJson<OrganizerContestDetail>(`/api/organizer/contests/${encodeURIComponent(contestId)}`)); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function editDraft(contestId: string) {
    try {
      const result = await forgeJson<OrganizerContestDetail>(`/api/organizer/contests/${encodeURIComponent(contestId)}`);
      if (result.contest.status !== "draft") { setMessage("Only contest drafts can be edited."); return; }
      setDetail(result);
      setEditingId(result.contest.id);
      setTitle(result.contest.title);
      setDescription(result.contest.description);
      setAccessMode(result.contest.accessMode);
      setInviteCode("");
      setStartsAt(contestDatetimeLocalValue(result.contest.startsAt));
      setEndsAt(contestDatetimeLocalValue(result.contest.endsAt));
      setFreezeAt(result.contest.freezeAt ? contestDatetimeLocalValue(result.contest.freezeAt) : "");
      setSelected(result.problems.map((problem) => problem.problemVersionId));
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function copyInvite(code: string) {
    try { await navigator.clipboard.writeText(code); setMessage("Invite code copied. Store it now; Forge only keeps its secure hash."); }
    catch { setMessage(`Copy this invite code now: ${code}`); }
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const payload = { title, description, accessMode, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), ...(freezeAt ? { freezeAt: new Date(freezeAt).toISOString() } : {}), ...(accessMode === "invite" && inviteCode ? { inviteCode } : {}), problemVersionIds: selected };
      const result = editingId
        ? await put<{ contestId: string }>(`/api/organizer/contests/${encodeURIComponent(editingId)}`, payload)
        : await post<{ contestId: string }>("/api/contests", payload);
      if (accessMode === "invite" && inviteCode) {
        inviteReturnRef.current = draftSaveReturnRef.current;
        setFreshInvite({ contestId: result.contestId, code: inviteCode, savedConfirmed: false, acknowledged: false });
      }
      await Promise.all([loadContests(), openDetail(result.contestId)]);
      setEditingId("");
      setMessage(editingId ? "Contest draft updated." : "Contest draft saved on the server. Review its preview before publishing.");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function requestContestAction(type: "publish" | "rotate-invite", contest: OrganizerContestSummary, trigger: HTMLButtonElement) {
    if (type === "publish" && contestInviteNeedsSaveConfirmation(freshInvite, contest.id)) {
      setMessage("Confirm that you saved the new invite code before publishing.");
      return;
    }
    contestConfirmationReturnRef.current = trigger;
    setMessage("");
    setContestConfirmation({ type, contest });
  }
  async function confirmContestAction() {
    if (!contestConfirmation) return;
    const { contest, type } = contestConfirmation;
    setBusy(true); setMessage("");
    try {
      if (type === "publish") {
        await post(`/api/contests/${contest.id}/publish`, {});
        setContestConfirmation(undefined);
        await loadContests();
        await openDetail(contest.id);
        setMessage("Contest published.");
      } else {
        const code = generateContestInviteCode();
        await post(`/api/organizer/contests/${contest.id}/invite-code`, { inviteCode: code });
        inviteReturnRef.current = contestConfirmationReturnRef.current;
        setContestConfirmation(undefined);
        setFreshInvite({ contestId: contest.id, code, savedConfirmed: false, acknowledged: false });
        await loadContests();
        await copyInvite(code);
      }
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const confirmationTitle = contestConfirmation?.type === "rotate-invite" ? "Rotate invite code" : "Publish contest";
  const confirmationDescription = contestConfirmation?.type === "rotate-invite"
    ? `Rotate the invite code for “${contestConfirmation.contest.title}”? The previous code will stop working immediately. The replacement is shown only once.`
    : `Publish “${contestConfirmation?.contest.title ?? "this contest"}”? Its schedule and selected problems will become available to participants.`;
  return <><main className="product-page" id="main-content" data-drawer-background>
    <header className="product-page-header"><span className="product-eyebrow"><Trophy size={14} /> Organizer</span><h1>Contest builder</h1><p>Choose published contest problems, arrange their order, and save a server-side draft before publishing.</p></header>
    {error && <div className="product-error">{error}</div>}
    <section className="organizer-product-section">
      <header className="organizer-actions"><h2>Your contests</h2><button type="button" title="Refresh contests" aria-label="Refresh contests" onClick={() => void loadContests()}><RefreshCw size={15} /></button></header>
      {contests.map((contest) => <article className="collection-summary" key={contest.id}>
        <div><span>{contest.status} · {contest.phase} · {contest.accessMode}</span><strong>{contest.title}</strong><small>{contest.problemCount} problems · {new Date(contest.startsAt).toLocaleString()}–{new Date(contest.endsAt).toLocaleString()}</small></div>
        <div className="organizer-actions">
          <button type="button" title={`Review ${contest.title}`} aria-label={`Review ${contest.title}`} onClick={() => void openDetail(contest.id)}><Eye size={16} /></button>
          <Link href={`/contests/${contest.id}`} title={`Preview ${contest.title}`} aria-label={`Preview ${contest.title}`}><ChevronRight size={16} /></Link>
          {contest.accessMode === "invite" && <button type="button" disabled={busy} onClick={(event) => requestContestAction("rotate-invite", contest, event.currentTarget)}>Rotate invite code</button>}
          {contest.status === "draft" && <><button type="button" disabled={busy} onClick={() => void editDraft(contest.id)}>Edit draft</button><button type="button" className="primary-action" disabled={busy} onClick={(event) => requestContestAction("publish", contest, event.currentTarget)}>Publish contest</button></>}
        </div>
        {freshInvite?.contestId === contest.id && <div><strong>New invite code</strong><code>{freshInvite.code}</code><button type="button" title="Copy invite code" aria-label="Copy invite code" onClick={() => void copyInvite(freshInvite.code)}><Copy size={15} /></button><small>{freshInvite.acknowledged ? "Saved confirmation complete." : "Save confirmation required."}</small></div>}
      </article>)}
      {contests.length === 0 && <p className="product-empty">No contest drafts yet. Create one below.</p>}
      {detail && <article className="organizer-panel"><h3>{detail.contest.title} · {detail.contest.status}</h3><p>{detail.contest.description || "No description."}</p>{detail.problems.map((problem) => <div className="selected-problem" key={problem.problemVersionId}><span>{problem.ordinal}</span><strong>{problemTitle({ slug: problem.problemSlug, title: problem.title })}</strong><small>{problem.repository} · revision {problem.collectionRevision.slice(0, 12)}</small></div>)}</article>}
    </section>
    <form className="contest-builder" onSubmit={(event) => void create(event)}>
      <section className="organizer-panel organizer-product-form"><h2>{editingId ? "Edit contest draft" : "New contest draft"}</h2><label>Title<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Description<textarea maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>Access<select value={accessMode} onChange={(event) => { const next = event.target.value as typeof accessMode; setAccessMode(next); if (next === "invite" && !inviteCode && !editingId) setInviteCode(generateContestInviteCode()); }}><option value="public">Public</option><option value="invite">Invite code</option></select></label>{accessMode === "invite" && <label>Invite code<div className="organizer-actions"><input required={!editingId} minLength={16} maxLength={128} placeholder={editingId ? "Leave blank to keep the current code" : undefined} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /><button type="button" title="Generate invite code" aria-label="Generate invite code" onClick={() => setInviteCode(generateContestInviteCode())}><RefreshCw size={15} /></button><button type="button" title="Copy invite code" aria-label="Copy invite code" disabled={!inviteCode} onClick={() => void copyInvite(inviteCode)}><Copy size={15} /></button></div><small>{editingId ? "Leave blank to keep the current code, or generate a replacement." : "Save this code before leaving; only its secure hash is stored."}</small></label>}<div className="organizer-date-grid"><label>Starts<input type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label>Ends<input type="datetime-local" required value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label><label>Freeze<input type="datetime-local" value={freezeAt} onChange={(event) => setFreezeAt(event.target.value)} /></label></div></section>
      <section className="organizer-panel problem-picker"><h2>Problems</h2><label className="catalog-search"><Search size={15} /><input value={search} placeholder="Search published contest problems…" onChange={(event) => setSearch(event.target.value)} /></label><div className="problem-picker-list">{filtered.map((problem) => <button type="button" className={selected.includes(problem.id) ? "is-selected" : ""} key={problem.id} onClick={() => toggle(problem.id)}><span>{problem.number}</span><div><strong>{problemTitle(problem)}</strong><small>{problem.collection}</small></div>{selected.includes(problem.id) && <Check size={15} />}</button>)}</div>{problems.length === 0 && <p className="product-empty">Publish a collection as contest material before creating a contest.</p>}<h3>Order</h3>{selected.map((id, index) => { const problem = problems.find((item) => item.id === id); return <div className="selected-problem" key={id}><span>{index + 1}</span><strong>{problem ? problemTitle(problem) : id}</strong><button type="button" title="Move problem up" aria-label="Move problem up" onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" title="Move problem down" aria-label="Move problem down" onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div>; })}<button ref={draftSaveReturnRef} className="primary-action" disabled={busy || selected.length === 0}>{editingId ? "Update contest draft" : "Save contest draft"}</button>{editingId && <button type="button" disabled={busy} onClick={() => setEditingId("")}>Cancel editing</button>}</section>
    </form>
    {message && <output className="product-message">{message}</output>}
  </main><Drawer open={Boolean(contestConfirmation)} label={confirmationTitle} onClose={() => { if (!busy) setContestConfirmation(undefined); }} returnFocusRef={contestConfirmationReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> Organizer confirmation</span><h2>{confirmationTitle}</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={() => setContestConfirmation(undefined)} /></header><p>{confirmationDescription}</p>{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={() => setContestConfirmation(undefined)}>Cancel</button><button type="button" className={contestConfirmation?.type === "rotate-invite" ? "danger-action" : "primary-action"} disabled={busy} onClick={() => void confirmContestAction()}>{contestConfirmation?.type === "rotate-invite" ? <><RefreshCw size={15} />Rotate code</> : "Publish contest"}</button></footer></div></Drawer><Drawer open={Boolean(freshInvite && !freshInvite.acknowledged)} label="Save invite code" onClose={() => setMessage("Save and confirm the new invite code before continuing.")} returnFocusRef={inviteReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> One-time secret</span><h2>Save invite code</h2></div></header>{freshInvite && <><p>Forge stores only its secure hash. Copy this code to your password manager or Organizer notes before continuing.</p><div className="organizer-actions"><code>{freshInvite.code}</code><IconButton icon={Copy} label="Copy invite code" onClick={() => void copyInvite(freshInvite.code)} /></div><label><span className="organizer-actions"><input type="checkbox" style={{ width: 16, height: 16, minHeight: 0, padding: 0, accentColor: "var(--product-primary)" }} checked={freshInvite.savedConfirmed} onChange={(event) => setFreshInvite((current) => current ? { ...current, savedConfirmed: event.target.checked } : current)} />I saved this invite code somewhere safe.</span></label>{message && <output className="product-message">{message}</output>}<footer><button type="button" className="primary-action" disabled={!freshInvite.savedConfirmed} onClick={() => setFreshInvite((current) => current ? { ...current, acknowledged: true } : current)}>Continue</button></footer></>}</div></Drawer></>;
}

export function OrganizerRejudges() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 重新判題" : "Organizer rejudges");
  return <OrganizerGate><RejudgesContent /></OrganizerGate>;
}

function RejudgesContent() {
  const [sources, setSources] = useState<readonly RejudgeVersionOption[]>([]);
  const [successors, setSuccessors] = useState<readonly RejudgeVersionOption[]>([]);
  const [history, setHistory] = useState<readonly RejudgeBatch[]>([]);
  const [oldId, setOldId] = useState(""); const [newId, setNewId] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<RejudgeBatch>();
  const cancelReturnRef = useRef<HTMLButtonElement>(null);
  const loadHistory = useCallback(async () => {
    const result = await forgeJson<{ rejudgeBatches: readonly RejudgeBatch[] }>("/api/organizer/rejudges");
    setHistory(result.rejudgeBatches);
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([forgeJson<{ sources: readonly RejudgeVersionOption[] }>("/api/organizer/rejudges/options"), forgeJson<{ rejudgeBatches: readonly RejudgeBatch[] }>("/api/organizer/rejudges")])
      .then(([optionResult, historyResult]) => { if (active) { setSources(optionResult.sources); setHistory(historyResult.rejudgeBatches); } })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!oldId) return () => { active = false; };
    void forgeJson<{ successors: readonly RejudgeVersionOption[] }>(`/api/organizer/rejudges/options?source=${encodeURIComponent(oldId)}`)
      .then((result) => { if (active) setSuccessors(result.successors); })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [oldId]);
  function selectRejudgeSource(problemVersionId: string) {
    setOldId(problemVersionId);
    setNewId("");
    setSuccessors([]);
  }
  const activeHistory = history.some((batch) => ["queued", "running", "ready", "cancelling"].includes(batch.status));
  useEffect(() => {
    if (!activeHistory) return;
    const timer = window.setInterval(() => void loadHistory().catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))), 2_000);
    return () => window.clearInterval(timer);
  }, [activeHistory, loadHistory]);
  const optionLabel = (option: RejudgeVersionOption) => `${option.repository.owner}/${option.repository.name} · ${option.number}. ${problemTitle(option)} · ${option.collectionRevision.slice(0, 10)}`;
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try { await post("/api/organizer/rejudges", { oldProblemVersionId: oldId, newProblemVersionId: newId, idempotencyKey: crypto.randomUUID() }); await loadHistory(); setMessage("Rejudge started. Progress will update automatically."); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!cancelTarget) return;
    setBusy(true); setMessage("");
    try { await post(`/api/organizer/rejudges/${cancelTarget.id}/cancel`, {}); setCancelTarget(undefined); await loadHistory(); setMessage("Rejudge cancellation requested."); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <><main className="product-page narrow-page" id="main-content" data-drawer-background>
    <header className="product-page-header"><span className="product-eyebrow"><Send size={14} /> Organizer</span><h1>Rejudge</h1><p>Choose an exact published version and its compatible successor. Existing results switch only after the full batch becomes effective.</p></header>
    <form className="organizer-panel organizer-product-form" onSubmit={(event) => void create(event)}><label>Current problem version<select required value={oldId} onChange={(event) => selectRejudgeSource(event.target.value)}><option value="">Choose a problem and revision…</option>{sources.map((option) => <option key={option.problemVersionId} value={option.problemVersionId}>{optionLabel(option)}</option>)}</select></label><label>New problem version<select required disabled={!oldId} value={newId} onChange={(event) => setNewId(event.target.value)}><option value="">Choose a compatible published successor…</option>{successors.map((option) => <option key={option.problemVersionId} value={option.problemVersionId}>{optionLabel(option)}</option>)}</select></label>{oldId && successors.length === 0 && <p className="product-empty">No compatible newer published version is available for this problem.</p>}<button className="primary-action" disabled={busy || !oldId || !newId || oldId === newId}>Start rejudge</button></form>
    <section className="organizer-product-section"><header className="organizer-actions"><h2>Rejudge history</h2><button type="button" title="Refresh rejudge history" aria-label="Refresh rejudge history" onClick={() => void loadHistory()}><RefreshCw size={15} /></button></header>{history.map((batch) => <article className="collection-summary" key={batch.id}><div><span>{batch.status} · {new Date(batch.createdAt).toLocaleString()}</span><strong>{batch.repository} · {batch.oldProblem.number}. {problemTitle(batch.oldProblem)}</strong><small>{batch.oldProblem.collectionRevision.slice(0, 12)} → {batch.newProblem.collectionRevision.slice(0, 12)}</small><small>{batch.completedCount}/{batch.expectedCount} complete · {batch.readyCount} ready · {batch.failedCount} failed</small>{batch.failureCode && <small>{batch.failureCode}</small>}</div>{batch.cancellable && <button type="button" disabled={busy} onClick={(event) => { cancelReturnRef.current = event.currentTarget; setCancelTarget(batch); }}>Cancel rejudge</button>}</article>)}{history.length === 0 && <p className="product-empty">No rejudge history yet.</p>}</section>
    {message && <output className="product-message">{message}</output>}
  </main><Drawer open={Boolean(cancelTarget)} label="Cancel rejudge" onClose={() => { if (!busy) setCancelTarget(undefined); }} returnFocusRef={cancelReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> Organizer confirmation</span><h2>Cancel rejudge</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={() => setCancelTarget(undefined)} /></header>{cancelTarget && <><p>Cancel the rejudge from revision {cancelTarget.oldProblem.collectionRevision.slice(0, 10)} to {cancelTarget.newProblem.collectionRevision.slice(0, 10)}? Unpublished child results will remain hidden and the effective problem version will not change.</p>{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={() => setCancelTarget(undefined)}>Keep rejudge</button><button type="button" className="danger-action" disabled={busy} onClick={() => void cancel()}><X size={15} />Cancel rejudge</button></footer></>}</div></Drawer></>;
}
