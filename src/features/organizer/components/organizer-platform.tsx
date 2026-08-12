"use client";

import { ArrowDown, ArrowUp, Check, ChevronRight, CircleAlert, CodeXml, Copy, Eye, GitBranch, LoaderCircle, RefreshCw, Search, Send, Trophy, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Drawer } from "../../../components/ui/drawer";
import { IconButton } from "../../../components/ui/icon-button";
import { wasmOjCsrfToken, wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";
import { requestWasmOjTurnstileToken } from "../../../turnstile/client";

interface OrganizerApplication { readonly id: string; readonly status: "pending" | "approved" | "rejected"; readonly created_at: string; readonly reviewed_at: string | null; readonly review_note: string | null; }
interface OrganizerStatus { readonly authenticated: boolean; readonly organizer: boolean; readonly access: "signed-out" | "eligible" | "pending" | "rejected" | "revoked" | "active"; readonly application: OrganizerApplication | null; }
interface Repository { readonly github_repository_id: number; readonly owner_login: string; readonly name: string; readonly is_private: number; }
interface OrganizerCollection {
  readonly id: string;
  readonly github_repository_id: number;
  readonly index_path: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner_login: string;
  readonly name: string;
}
interface CollectionResult { readonly collections: readonly OrganizerCollection[]; }
interface CatalogValidation {
  readonly id: string;
  readonly collectionId: string;
  readonly requestedRef: string;
  readonly commitSha: string;
  readonly state: "queued" | "running" | "valid" | "invalid" | "infrastructure-error";
  readonly errorCode: string | null;
  readonly revisionId: string | null;
  readonly summary: {
    readonly schema: "wasm-oj-platform/catalog-validation-summary/v2";
    readonly valid: true;
    readonly commitSha: string;
    readonly collectionRevision: string;
    readonly problemCount: number;
  } | null;
}
interface CatalogPublication {
  readonly id: string | null;
  readonly jobId: string;
  readonly state: "queued" | "materializing" | "published" | "failed";
  readonly mode: "official-practice" | "contest";
  readonly status: "published" | null;
  readonly errorCode: string | null;
}
interface OrganizerContestPublication {
  readonly id: string;
  readonly mode: "contest";
  readonly publishedAt: string;
  readonly repository: { readonly id: number; readonly owner: string; readonly name: string };
  readonly problems: readonly {
    readonly problemVersionId: string;
    readonly problemSeriesId: string;
    readonly slug: string;
    readonly number: number;
    readonly title: Record<string, string>;
    readonly executionSemanticSha256: string;
  }[];
}
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
  readonly catalogPublicationId: string | null;
  readonly updatedAt: string;
}
interface OrganizerContestDetail {
  readonly contest: OrganizerContestSummary;
  readonly problems: readonly { readonly ordinal: number; readonly problemVersionId: string; readonly problemSlug: string; readonly problemNumber: number; readonly title: Record<string, string>; readonly collectionRevision: string; readonly repository: string }[];
}
interface RejudgeVersionOption {
  readonly problemVersionId: string;
  readonly problemSeriesId: string;
  readonly slug: string;
  readonly number: number;
  readonly title: Record<string, string>;
  readonly mode: "official-practice" | "contest";
  readonly publicationStatus: "published";
  readonly publishedAt: string | null;
  readonly executionSemanticSha256: string;
  readonly repository: { readonly owner: string; readonly name: string };
}
interface RejudgeBatch {
  readonly id: string;
  readonly oldProblemVersionId: string;
  readonly newProblemVersionId: string;
  readonly problemSeriesId: string;
  readonly status: string;
  readonly expectedCount: number;
  readonly completedCount: number;
  readonly readyCount: number;
  readonly failedCount: number;
  readonly failureCode: string | null;
  readonly cancelRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly effectiveAt: string | null;
}

export const CATALOG_POLL_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function catalogPollDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError("Catalog poll attempt must be a non-negative integer.");
  return CATALOG_POLL_DELAYS_MS[Math.min(attempt, CATALOG_POLL_DELAYS_MS.length - 1)]!;
}

export function isTerminalCatalogValidation(state: CatalogValidation["state"]): boolean {
  return state === "valid" || state === "invalid" || state === "infrastructure-error";
}

export function isTerminalCatalogPublication(state: CatalogPublication["state"]): boolean {
  return state === "published" || state === "failed";
}

export function catalogIssueMessage(code: string | null): string {
  if (!code) return "";
  return ({
    "catalog-contract-invalid": "The collection schema, declared paths, sizes, digests, redaction, or judge package is invalid. Fix the repository and validate a new exact commit.",
    "catalog-validation-failed": "Static validation failed. Fix the repository and validate a new exact commit.",
    "github-content-unavailable": "GitHub could not serve the declared exact-commit content. Validate again after GitHub recovers.",
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
  return wasmOjMutation<T>(path, body);
}

function put<T>(path: string, body: unknown): Promise<T> {
  return wasmOjMutation<T>(path, body, "PUT");
}

function useOrganizer() {
  const [status, setStatus] = useState<OrganizerStatus>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setStatus(await wasmOjJson<OrganizerStatus>("/api/organizer/status")); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  useEffect(() => {
    let active = true;
    void wasmOjJson<OrganizerStatus>("/api/organizer/status")
      .then((value) => { if (active) setStatus(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  return { status, error, refresh };
}

async function submitApplication(statement: string): Promise<void> {
  const csrf = wasmOjCsrfToken();
  if (!csrf) throw new Error("Sign in again: the CSRF token is missing.");
  const request = async (turnstile?: string) => fetch("/api/organizer/applications", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json", "x-wasm-oj-csrf": csrf, ...(turnstile ? { "x-wasm-oj-turnstile-token": turnstile } : {}) }, body: JSON.stringify({ statement }) });
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
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  if (error) return <main className="product-page" id="main-content"><div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div></main>;
  if (!status) return <main className="product-page" id="main-content"><div className="product-empty large">Loading Organizer access…</div></main>;
  if (!status.authenticated) return <main className="product-page narrow-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Publish learning material</h1><p>Connect a reviewed Organizer account to validate exact commits and publish collections.</p></header><a className="primary-action" href="/api/auth/github?return=/organizer/repositories">Sign in with GitHub</a></main>;
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
  const [message, setMessage] = useState("");
  const [githubResult] = useState(() => initialSearchParameter("github"));
  useEffect(() => {
    let active = true;
    void wasmOjJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories")
      .then((repositoryResult) => { if (active) setRepositories(repositoryResult.repositories); })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  const githubMessage = githubResult === "connected"
    ? "GitHub repositories connected."
    : githubResult
      ? ({
        "sign-in-required": "Sign in again before connecting GitHub repositories.",
        "invalid-callback": "GitHub did not return a valid installation. Try connecting again.",
        "account-mismatch": "The selected GitHub installation belongs to a different account.",
        "installation-suspended": "This GitHub App installation is suspended.",
        "repository-limit": "WASM-OJ supports up to 100 repositories in one installation.",
        "github-unavailable": "GitHub could not complete the connection. Try again.",
      } as Record<string, string>)[githubResult] ?? "GitHub could not complete the connection."
      : "";
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><GitBranch size={14} /> Organizer</span><h1>Repositories</h1><p>Connect the read-only GitHub App to repositories that contain WASM-OJ collections. WASM-OJ resolves only refs you explicitly validate.</p></header>{githubMessage && <output className={githubResult === "connected" ? "product-message" : "product-error"}>{githubMessage}</output>}<a className="primary-action" href="/api/organizer/github/install">Connect or update repositories</a><section className="organizer-product-section"><h2>Connected repositories</h2>{repositories.map((repository) => <article className="organizer-resource-row" key={repository.github_repository_id}><GitBranch size={17} /><div><strong>{repository.owner_login}/{repository.name}</strong><span>{repository.is_private ? "Private" : "Public"}</span></div><Check size={16} /></article>)}{repositories.length === 0 && <p className="product-empty">No repositories connected. Connect the GitHub App to continue.</p>}</section>{message && <output className="product-message">{message}</output>}</main>;
}

export function OrganizerCollections() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 題庫" : "Organizer collections");
  return <OrganizerGate><CollectionsContent /></OrganizerGate>;
}

function CollectionsContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [data, setData] = useState<CollectionResult>({ collections: [] });
  const [repositoryId, setRepositoryId] = useState(() => initialSearchParameter("repositoryId"));
  const [ref, setRef] = useState(() => initialSearchParameter("ref", "main"));
  const [indexPath, setIndexPath] = useState("collection/index.json");
  const [validation, setValidation] = useState<CatalogValidation>();
  const [publication, setPublication] = useState<CatalogPublication>();
  const [publishMode, setPublishMode] = useState<"official-practice" | "contest">();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const publishReturnRef = useRef<HTMLButtonElement>(null);
  const publicationRequestKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const [repositoryResult, collectionResult] = await Promise.all([wasmOjJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"), wasmOjJson<CollectionResult>("/api/organizer/collections")]);
    setRepositories(repositoryResult.repositories); setData(collectionResult);
    setRepositoryId((current) => current || String(repositoryResult.repositories[0]?.github_repository_id ?? ""));
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([wasmOjJson<{ repositories: readonly Repository[] }>("/api/organizer/repositories"), wasmOjJson<CollectionResult>("/api/organizer/collections")])
      .then(([repositoryResult, collectionResult]) => {
        if (!active) return;
        setRepositories(repositoryResult.repositories);
        setData(collectionResult);
        setRepositoryId((current) => current || String(repositoryResult.repositories[0]?.github_repository_id ?? ""));
      })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  const validationJobId = validation?.id;
  const validationPolling = validation ? !isTerminalCatalogValidation(validation.state) : false;
  useEffect(() => {
    if (!validationJobId || !validationPolling) return;
    let cancelled = false;
    let attempt = 0;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await wasmOjJson<{ validation: CatalogValidation }>(`/api/organizer/validations/${encodeURIComponent(validationJobId)}`);
        if (cancelled) return;
        setValidation(result.validation);
        if (isTerminalCatalogValidation(result.validation.state)) return;
      } catch (reason) {
        if (!cancelled) setMessage(reason instanceof Error ? reason.message : String(reason));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), catalogPollDelay(attempt++));
    };
    timer = window.setTimeout(() => void poll(), catalogPollDelay(attempt++));
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [validationJobId, validationPolling]);

  const publicationJobId = publication?.jobId;
  const publicationPolling = publication ? !isTerminalCatalogPublication(publication.state) : false;
  const validationRevisionId = validation?.revisionId;
  useEffect(() => {
    if (!publicationJobId || !publicationPolling) return;
    let cancelled = false;
    let attempt = 0;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await wasmOjJson<{ publication: CatalogPublication }>(`/api/organizer/publications/${encodeURIComponent(publicationJobId)}`);
        if (cancelled) return;
        setPublication(result.publication);
        if (result.publication.state === "failed" && validationRevisionId) {
          publicationRequestKeys.current.delete(`${validationRevisionId}:${result.publication.mode}`);
        }
        if (isTerminalCatalogPublication(result.publication.state)) return;
      } catch (reason) {
        if (!cancelled) setMessage(reason instanceof Error ? reason.message : String(reason));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), catalogPollDelay(attempt++));
    };
    timer = window.setTimeout(() => void poll(), catalogPollDelay(attempt++));
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [publicationJobId, publicationPolling, validationRevisionId]);

  async function createValidation(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const collectionResult = await post<{ collection: { readonly id: string } }>("/api/organizer/collections", {
        githubRepositoryId: Number(repositoryId),
        indexPath,
      });
      const result = await post<{ validation: CatalogValidation }>(
        `/api/organizer/collections/${encodeURIComponent(collectionResult.collection.id)}/validations`,
        { ref },
      );
      setValidation(result.validation);
      setPublication(undefined);
      publicationRequestKeys.current.clear();
      await load();
      setMessage(result.validation.state === "valid"
        ? `Resolved ${result.validation.commitSha.slice(0, 12)} to an existing valid revision. Publication is ready.`
        : `Resolved ${result.validation.commitSha.slice(0, 12)} once. Static validation is queued.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function publish() {
    if (!validation?.revisionId || !publishMode) return;
    const mode = publishMode;
    const requestIdentity = `${validation.revisionId}:${mode}`;
    const idempotencyKey = publicationRequestKeys.current.get(requestIdentity) ?? crypto.randomUUID();
    publicationRequestKeys.current.set(requestIdentity, idempotencyKey);
    setBusy(true); setMessage("");
    try {
      const result = await post<{ publicationJob: { readonly id: string } }>(
        `/api/organizer/revisions/${encodeURIComponent(validation.revisionId)}/publications`,
        { mode, idempotencyKey },
      );
      setPublication({ id: null, jobId: result.publicationJob.id, state: "queued", mode, status: null, errorCode: null });
      setPublishMode(undefined);
      setMessage(`Explicit ${mode} publication is queued.`);
    }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function activate() {
    if (!publication?.id || publication.mode !== "official-practice" || publication.state !== "published") return;
    setBusy(true); setMessage("");
    try {
      const result = await post<{ activation: { readonly activatedProblems: number } }>(
        `/api/organizer/publications/${encodeURIComponent(publication.id)}/activate`,
        {},
      );
      setMessage(`Activated ${result.activation.activatedProblems} official-practice problem heads.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const step = publication?.state === "published" ? 4 : validation?.state === "valid" ? 3 : validation ? 2 : 1;
  const publicationWarning = `Materialize immutable judge packages and publish this exact revision as ${publishMode === "contest" ? "contest material" : "official practice"}?`;
  return <><main className="product-page" id="main-content" data-drawer-background>
    <header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Collections</h1><p>Resolve one requested ref to an exact commit, statically validate declared content, then explicitly publish and activate. Validation never executes judge code.</p></header>
    <div className="wizard-steps">{["Collection", "Static validation", "Publication", "Activation"].map((label, index) => <span className={index + 1 <= step ? "is-active" : ""} key={label}><i>{index + 1}</i>{label}</span>)}</div>
    <div className="organizer-split">
      <form className="organizer-panel organizer-product-form" onSubmit={(event) => void createValidation(event)}>
        <h2>1. Choose source</h2>
        {repositories.length === 0 && <p className="product-empty">Connect a repository before validating. <Link href="/organizer/repositories">Open repositories</Link></p>}
        <label>Repository<select required value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>{repositories.map((repository) => <option key={repository.github_repository_id} value={repository.github_repository_id}>{repository.owner_login}/{repository.name}{repository.is_private ? " · private" : ""}</option>)}</select></label>
        <label>Branch, tag, or exact commit<input required value={ref} onChange={(event) => setRef(event.target.value)} /></label>
        <label>Collection index<input required value={indexPath} onChange={(event) => setIndexPath(event.target.value)} /></label>
        <button className="primary-action" disabled={busy || !repositoryId}>Validate exact commit</button>
      </form>
      <section className="organizer-panel">
        <h2>2–4. Validate, publish, activate</h2>
        {validation ? <div className="catalog-job-result">
          <span className={`catalog-job-state state-${validation.state}`}>{validation.state === "queued" || validation.state === "running" ? <LoaderCircle size={14} className="spin" /> : validation.state === "valid" ? <Check size={14} /> : <CircleAlert size={14} />}{validation.state}</span>
          <dl><dt>Requested ref</dt><dd>{validation.requestedRef}</dd><dt>Exact commit</dt><dd><code>{validation.commitSha}</code></dd>{validation.errorCode && <><dt>Issue</dt><dd>{catalogIssueMessage(validation.errorCode)}</dd></>}</dl>
          {validation.summary && <div className="collection-summary"><div><span>Static contract verified</span><strong>{validation.summary.problemCount} problems</strong><small>Revision {validation.summary.collectionRevision.slice(0, 12)}</small></div></div>}
          <div className="organizer-actions"><button className="primary-action" type="button" disabled={busy || validation.state !== "valid" || !validation.revisionId} onClick={(event) => { publishReturnRef.current = event.currentTarget; setMessage(""); setPublishMode("official-practice"); }}>Publish practice</button><button className="secondary-action" type="button" disabled={busy || validation.state !== "valid" || !validation.revisionId} onClick={(event) => { publishReturnRef.current = event.currentTarget; setMessage(""); setPublishMode("contest"); }}>Publish for contest</button></div>
          {publication && <div className="collection-summary"><div><span>{publication.mode}</span><strong>{publication.state === "published" ? "Immutable publication ready" : `Publication ${publication.state}`}</strong>{publication.errorCode && <small>{catalogIssueMessage(publication.errorCode)}</small>}</div>{publication.mode === "official-practice" && publication.state === "published" && publication.id && <button className="primary-action" type="button" disabled={busy} onClick={() => void activate()}>Activate official practice</button>}</div>}
        </div> : <p className="product-empty">Start a static validation to see its exact-commit result here.</p>}
      </section>
    </div>
    <section className="organizer-product-section"><h2>Configured collections</h2>{data.collections.map((collection) => <article className="collection-summary" key={collection.id}><div><span>GitHub authoring authority</span><strong>{collection.owner_login}/{collection.name}</strong><small>{collection.index_path}</small></div></article>)}{data.collections.length === 0 && <p className="product-empty">No collection pointers configured yet.</p>}</section>
    {message && <output className="product-message">{message}</output>}
  </main><Drawer open={Boolean(publishMode)} label="Publish collection" onClose={() => { if (!busy) setPublishMode(undefined); }} returnFocusRef={publishReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> Organizer confirmation</span><h2>{publishMode === "contest" ? "Publish contest material" : "Publish official practice"}</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={() => setPublishMode(undefined)} /></header><p>{publicationWarning}</p>{validation && <p>Exact commit <code>{validation.commitSha.slice(0, 12)}</code> passed static validation. Publishing copies only immutable judge packages to R2.</p>}{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={() => setPublishMode(undefined)}>Cancel</button><button type="button" className="primary-action" disabled={busy} onClick={() => void publish()}>{publishMode === "contest" ? "Publish for contest" : "Publish practice"}</button></footer></div></Drawer></>;
}

function useOrganizerContestPublications() {
  const [publications, setPublications] = useState<readonly OrganizerContestPublication[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void wasmOjJson<{ publications: readonly OrganizerContestPublication[] }>("/api/organizer/publications?mode=contest")
      .then((value) => { if (active) setPublications(value.publications); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  return { publications, error };
}

export function OrganizerContests() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 競賽" : "Organizer contests");
  return <OrganizerGate><ContestsContent /></OrganizerGate>;
}

function ContestsContent() {
  const { publications, error } = useOrganizerContestPublications();
  const [selectedPublicationId, setSelectedPublicationId] = useState("");
  const selectedPublication = publications.find((publication) => publication.id === selectedPublicationId)
    ?? publications[0];
  const catalogPublicationId = selectedPublication?.id ?? "";
  const problems = useMemo(() => (selectedPublication?.problems ?? []).map((problem) => ({
    id: problem.problemVersionId,
    slug: problem.slug,
    number: problem.number,
    title: problem.title,
    collection: `${selectedPublication!.repository.owner}/${selectedPublication!.repository.name}`,
  })), [selectedPublication]);
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
  const filtered = problems.filter((problem) => `${problem.number} ${problem.slug} ${Object.values(problem.title).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const loadContests = useCallback(async () => {
    const result = await wasmOjJson<{ contests: readonly OrganizerContestSummary[] }>("/api/organizer/contests");
    setContests(result.contests);
  }, []);
  useEffect(() => {
    let active = true;
    void wasmOjJson<{ contests: readonly OrganizerContestSummary[] }>("/api/organizer/contests")
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
    try { setDetail(await wasmOjJson<OrganizerContestDetail>(`/api/organizer/contests/${encodeURIComponent(contestId)}`)); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function editDraft(contestId: string) {
    try {
      const result = await wasmOjJson<OrganizerContestDetail>(`/api/organizer/contests/${encodeURIComponent(contestId)}`);
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
      if (!result.contest.catalogPublicationId) throw new Error("Contest draft is not bound to an explicit catalog publication.");
      setSelectedPublicationId(result.contest.catalogPublicationId);
      setSelected(result.problems.map((problem) => problem.problemVersionId));
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function copyInvite(code: string) {
    try { await navigator.clipboard.writeText(code); setMessage("Invite code copied. Store it now; WASM-OJ only keeps its secure hash."); }
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
      <section className="organizer-panel problem-picker"><h2>Problems</h2><label>Published contest revision<select required value={catalogPublicationId} onChange={(event) => { setSelectedPublicationId(event.target.value); setSelected([]); }}><option value="">Choose an explicit publication…</option>{publications.map((publication) => <option key={publication.id} value={publication.id}>{publication.repository.owner}/{publication.repository.name} · {new Date(publication.publishedAt).toLocaleString()}</option>)}</select></label><label className="catalog-search"><Search size={15} /><input value={search} placeholder="Search this publication…" onChange={(event) => setSearch(event.target.value)} /></label><div className="problem-picker-list">{filtered.map((problem) => <button type="button" className={selected.includes(problem.id) ? "is-selected" : ""} key={problem.id} onClick={() => toggle(problem.id)}><span>{problem.number}</span><div><strong>{problemTitle(problem)}</strong><small>{problem.collection}</small></div>{selected.includes(problem.id) && <Check size={15} />}</button>)}</div>{publications.length === 0 && <p className="product-empty">Publish a collection as contest material before creating a contest.</p>}<h3>Order</h3>{selected.map((id, index) => { const problem = problems.find((item) => item.id === id); return <div className="selected-problem" key={id}><span>{index + 1}</span><strong>{problem ? problemTitle(problem) : id}</strong><button type="button" title="Move problem up" aria-label="Move problem up" onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" title="Move problem down" aria-label="Move problem down" onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div>; })}<button ref={draftSaveReturnRef} className="primary-action" disabled={busy || selected.length === 0 || !catalogPublicationId}>{editingId ? "Update contest draft" : "Save contest draft"}</button>{editingId && <button type="button" disabled={busy} onClick={() => setEditingId("")}>Cancel editing</button>}</section>
    </form>
    {message && <output className="product-message">{message}</output>}
  </main><Drawer open={Boolean(contestConfirmation)} label={confirmationTitle} onClose={() => { if (!busy) setContestConfirmation(undefined); }} returnFocusRef={contestConfirmationReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> Organizer confirmation</span><h2>{confirmationTitle}</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={() => setContestConfirmation(undefined)} /></header><p>{confirmationDescription}</p>{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={() => setContestConfirmation(undefined)}>Cancel</button><button type="button" className={contestConfirmation?.type === "rotate-invite" ? "danger-action" : "primary-action"} disabled={busy} onClick={() => void confirmContestAction()}>{contestConfirmation?.type === "rotate-invite" ? <><RefreshCw size={15} />Rotate code</> : "Publish contest"}</button></footer></div></Drawer><Drawer open={Boolean(freshInvite && !freshInvite.acknowledged)} label="Save invite code" onClose={() => setMessage("Save and confirm the new invite code before continuing.")} returnFocusRef={inviteReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> One-time secret</span><h2>Save invite code</h2></div></header>{freshInvite && <><p>WASM-OJ stores only its secure hash. Copy this code to your password manager or Organizer notes before continuing.</p><div className="organizer-actions"><code>{freshInvite.code}</code><IconButton icon={Copy} label="Copy invite code" onClick={() => void copyInvite(freshInvite.code)} /></div><label><span className="organizer-actions"><input type="checkbox" style={{ width: 16, height: 16, minHeight: 0, padding: 0, accentColor: "var(--product-primary)" }} checked={freshInvite.savedConfirmed} onChange={(event) => setFreshInvite((current) => current ? { ...current, savedConfirmed: event.target.checked } : current)} />I saved this invite code somewhere safe.</span></label>{message && <output className="product-message">{message}</output>}<footer><button type="button" className="primary-action" disabled={!freshInvite.savedConfirmed} onClick={() => setFreshInvite((current) => current ? { ...current, acknowledged: true } : current)}>Continue</button></footer></>}</div></Drawer></>;
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
    const result = await wasmOjJson<{ rejudgeBatches: readonly RejudgeBatch[] }>("/api/organizer/rejudges");
    setHistory(result.rejudgeBatches);
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([wasmOjJson<{ sources: readonly RejudgeVersionOption[] }>("/api/organizer/rejudges/options"), wasmOjJson<{ rejudgeBatches: readonly RejudgeBatch[] }>("/api/organizer/rejudges")])
      .then(([optionResult, historyResult]) => { if (active) { setSources(optionResult.sources); setHistory(historyResult.rejudgeBatches); } })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!oldId) return () => { active = false; };
    void wasmOjJson<{ successors: readonly RejudgeVersionOption[] }>(`/api/organizer/rejudges/options?source=${encodeURIComponent(oldId)}`)
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
  const optionLabel = (option: RejudgeVersionOption) => `${option.repository.owner}/${option.repository.name} · ${option.number}. ${problemTitle(option)} · ${option.executionSemanticSha256.slice(0, 10)}`;
  const versionLabel = (problemVersionId: string) => {
    const option = [...sources, ...successors].find((candidate) => candidate.problemVersionId === problemVersionId);
    return option ? optionLabel(option) : problemVersionId;
  };
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
    <section className="organizer-product-section"><header className="organizer-actions"><h2>Rejudge history</h2><button type="button" title="Refresh rejudge history" aria-label="Refresh rejudge history" onClick={() => void loadHistory()}><RefreshCw size={15} /></button></header>{history.map((batch) => { const cancellable = ["queued", "running", "ready"].includes(batch.status) && batch.cancelRequestedAt === null; return <article className="collection-summary" key={batch.id}><div><span>{batch.status} · {new Date(batch.createdAt).toLocaleString()}</span><strong>{versionLabel(batch.oldProblemVersionId)}</strong><small>{batch.oldProblemVersionId.slice(0, 12)} → {batch.newProblemVersionId.slice(0, 12)}</small><small>{batch.completedCount}/{batch.expectedCount} complete · {batch.readyCount} ready · {batch.failedCount} failed</small>{batch.failureCode && <small>{batch.failureCode}</small>}</div>{cancellable && <button type="button" disabled={busy} onClick={(event) => { cancelReturnRef.current = event.currentTarget; setCancelTarget(batch); }}>Cancel rejudge</button>}</article>; })}{history.length === 0 && <p className="product-empty">No rejudge history yet.</p>}</section>
    {message && <output className="product-message">{message}</output>}
  </main><Drawer open={Boolean(cancelTarget)} label="Cancel rejudge" onClose={() => { if (!busy) setCancelTarget(undefined); }} returnFocusRef={cancelReturnRef}><div className="account-delete-drawer"><header><div><span className="product-eyebrow"><CircleAlert aria-hidden="true" size={14} /> Organizer confirmation</span><h2>Cancel rejudge</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={() => setCancelTarget(undefined)} /></header>{cancelTarget && <><p>Cancel the rejudge from problem version <code>{cancelTarget.oldProblemVersionId.slice(0, 12)}</code> to <code>{cancelTarget.newProblemVersionId.slice(0, 12)}</code>? Unpublished child results remain hidden and the effective version will not change.</p>{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={() => setCancelTarget(undefined)}>Keep rejudge</button><button type="button" className="danger-action" disabled={busy} onClick={() => void cancel()}><X size={15} />Cancel rejudge</button></footer></>}</div></Drawer></>;
}
