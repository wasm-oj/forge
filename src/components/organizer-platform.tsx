"use client";

import { ArrowDown, ArrowUp, Check, ChevronRight, CircleAlert, CodeXml, GitBranch, LoaderCircle, Search, Send, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { requestForgeTurnstileToken } from "../turnstile/client";
import { csrfToken, forgeJson } from "./online-api";

interface OrganizerApplication { readonly id: string; readonly status: "pending" | "approved" | "rejected"; readonly created_at: string; }
interface OrganizerStatus { readonly authenticated: boolean; readonly organizer: boolean; readonly application: OrganizerApplication | null; }
interface Repository { readonly github_repository_id: number; readonly owner_login: string; readonly name: string; readonly is_private: number; }
interface PushNotice { readonly id: string; readonly repository: string; readonly private: boolean; readonly commitSha: string; readonly ref: string; readonly receivedAt: string; readonly acknowledgedAt: string | null; }
interface OrganizerImport { readonly id: string; readonly requested_ref: string; readonly commit_sha: string; readonly index_path: string; readonly status: string; readonly error_code: string | null; readonly created_at: string; readonly updated_at: string; readonly repository_name: string; readonly owner_login: string; }
interface OrganizerProblem { readonly id: string; readonly slug: string; readonly number: number; readonly title: Record<string, string>; readonly difficulty: string | null; readonly tags: readonly string[]; }
interface OrganizerCollection { readonly snapshotId: string; readonly importId: string; readonly mode: "official-practice" | "contest"; readonly revision: string; readonly status: string; readonly publishedAt: string | null; readonly repository: { readonly id: number; readonly owner: string; readonly name: string }; readonly problems: readonly OrganizerProblem[]; }
interface CollectionResult { readonly imports: readonly OrganizerImport[]; readonly collections: readonly OrganizerCollection[]; }

function post<T>(path: string, body: unknown): Promise<T> {
  const csrf = csrfToken();
  if (!csrf) return Promise.reject(new Error("Sign in again: the CSRF token is missing."));
  return forgeJson<T>(path, { method: "POST", headers: { "content-type": "application/json", "x-forge-csrf": csrf }, body: JSON.stringify(body) });
}

function useOrganizer() {
  const [status, setStatus] = useState<OrganizerStatus>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => setStatus(await forgeJson<OrganizerStatus>("/api/organizer/status")), []);
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
  if (error) return <div className="product-page"><div className="product-error">{error}</div></div>;
  if (!status) return <div className="product-page"><div className="product-empty large">Loading Organizer access…</div></div>;
  if (!status.authenticated) return <div className="product-page narrow-page"><header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Publish learning material</h1><p>Connect a reviewed Organizer account to import and publish collections.</p></header><a className="primary-action" href="/api/auth/github?return=/organizer/repositories">Sign in with GitHub</a></div>;
  if (!status.organizer) return <div className="product-page narrow-page"><header className="product-page-header"><span className="product-eyebrow"><CircleAlert size={14} /> Organizer</span><h1>Organizer review</h1><p>Organizer access is reviewed before private repositories or publishing controls become available.</p></header>{status.application?.status === "pending" ? <section className="organizer-panel"><h2>Application pending</h2><p>Submitted {new Date(status.application.created_at).toLocaleString()}.</p></section> : <form className="organizer-panel organizer-product-form" onSubmit={(event) => { event.preventDefault(); setBusy(true); setMessage(""); void submitApplication(statement).then(refresh).then(() => setMessage("Application submitted.")).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}><h2>{status.application?.status === "rejected" ? "Apply again" : "Apply for Organizer access"}</h2><label>How will you use managed collections?<textarea minLength={40} maxLength={4000} required value={statement} onChange={(event) => setStatement(event.target.value)} /></label><button className="primary-action" disabled={busy}>Send for review</button></form>}{message && <output className="product-message">{message}</output>}</div>;
  return <>{children}</>;
}

export function OrganizerRepositories() {
  return <OrganizerGate><RepositoriesContent /></OrganizerGate>;
}

function RepositoriesContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [notices, setNotices] = useState<readonly PushNotice[]>([]);
  const [message, setMessage] = useState("");
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
  return <div className="product-page"><header className="product-page-header"><span className="product-eyebrow"><GitBranch size={14} /> Organizer</span><h1>Repositories</h1><p>Connect the read-only GitHub App to the repositories that contain your Forge collections.</p></header><a className="primary-action" href="/api/organizer/github/install">Connect or update repositories</a><section className="organizer-product-section"><h2>Connected repositories</h2>{repositories.map((repository) => <article className="organizer-resource-row" key={repository.github_repository_id}><GitBranch size={17} /><div><strong>{repository.owner_login}/{repository.name}</strong><span>{repository.is_private ? "Private" : "Public"}</span></div><Check size={16} /></article>)}{repositories.length === 0 && <p className="product-empty">No repositories connected.</p>}</section><section className="organizer-product-section"><h2>Repository updates</h2>{notices.filter((notice) => !notice.acknowledgedAt).map((notice) => <article className="organizer-resource-row" key={notice.id}><CircleAlert size={17} /><div><strong>{notice.repository}</strong><span>{notice.ref} · {notice.commitSha.slice(0, 10)} · {new Date(notice.receivedAt).toLocaleString()}</span></div><button type="button" onClick={() => void acknowledge(notice.id)}>Acknowledge</button></article>)}{notices.every((notice) => notice.acknowledgedAt) && <p className="product-empty">No new repository updates.</p>}</section>{message && <output className="product-message">{message}</output>}</div>;
}

export function OrganizerCollections() {
  return <OrganizerGate><CollectionsContent /></OrganizerGate>;
}

function CollectionsContent() {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [data, setData] = useState<CollectionResult>({ imports: [], collections: [] });
  const [repositoryId, setRepositoryId] = useState("");
  const [ref, setRef] = useState("main");
  const [indexPath, setIndexPath] = useState("collection/index.json");
  const [selectedImportId, setSelectedImportId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    if (!selectedImport || ["valid", "invalid", "infrastructure-error"].includes(selectedImport.status)) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [load, selectedImport]);

  async function createImport(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await post<{ importId: string; commitSha: string; status: string }>("/api/organizer/imports", { githubRepositoryId: Number(repositoryId), ref, indexPath });
      setSelectedImportId(result.importId); await load(); setMessage(`Resolved ${result.commitSha.slice(0, 12)}. Format check is ${result.status}.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function publish(mode: "official-practice" | "contest") {
    if (!selectedImport) return; setBusy(true); setMessage("");
    try { const result = await post<{ snapshotId: string; problems: readonly OrganizerProblem[] }>(`/api/organizer/imports/${encodeURIComponent(selectedImport.id)}/publish`, { mode }); await load(); setMessage(`Published ${result.problems.length} problems as ${mode}.`); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }

  const step = !selectedImport ? 1 : selectedImport.status === "valid" ? 3 : ["invalid", "infrastructure-error"].includes(selectedImport.status) ? 2 : 2;
  return <div className="product-page"><header className="product-page-header"><span className="product-eyebrow"><CodeXml size={14} /> Organizer</span><h1>Collections</h1><p>Import one exact Git commit, check its format and packaging, review the result, then publish.</p></header><div className="wizard-steps">{["Repository", "Format check", "Review", "Publish"].map((label, index) => <span className={index + 1 <= step + (selectedImport?.status === "valid" ? 1 : 0) ? "is-active" : ""} key={label}><i>{index + 1}</i>{label}</span>)}</div><div className="organizer-split"><form className="organizer-panel organizer-product-form" onSubmit={(event) => void createImport(event)}><h2>1. Choose source</h2><label>Repository<select required value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>{repositories.map((repository) => <option key={repository.github_repository_id} value={repository.github_repository_id}>{repository.owner_login}/{repository.name}{repository.is_private ? " · private" : ""}</option>)}</select></label><label>Branch, tag, or commit<input required value={ref} onChange={(event) => setRef(event.target.value)} /></label><label>Collection index<input required value={indexPath} onChange={(event) => setIndexPath(event.target.value)} /></label><button className="primary-action" disabled={busy || !repositoryId}>Check collection</button></form><section className="organizer-panel"><h2>2–4. Review and publish</h2><label className="organizer-select-label">Import<select value={selectedImportId} onChange={(event) => setSelectedImportId(event.target.value)}>{data.imports.map((item) => <option key={item.id} value={item.id}>{item.owner_login}/{item.repository_name} · {item.requested_ref} · {item.status}</option>)}</select></label>{selectedImport ? <div className="import-result"><span className={`import-state state-${selectedImport.status}`}>{selectedImport.status.includes("ing") || selectedImport.status === "queued" ? <LoaderCircle size={14} className="spin" /> : selectedImport.status === "valid" ? <Check size={14} /> : <CircleAlert size={14} />}{selectedImport.status}</span><dl><dt>Repository</dt><dd>{selectedImport.owner_login}/{selectedImport.repository_name}</dd><dt>Commit</dt><dd><code>{selectedImport.commit_sha.slice(0, 12)}</code></dd><dt>Index</dt><dd>{selectedImport.index_path}</dd>{selectedImport.error_code && <><dt>Issue</dt><dd>{selectedImport.error_code}</dd></>}</dl><div className="organizer-actions"><button className="primary-action" type="button" disabled={busy || selectedImport.status !== "valid"} onClick={() => void publish("official-practice")}>Publish practice</button><button className="secondary-action" type="button" disabled={busy || selectedImport.status !== "valid"} onClick={() => void publish("contest")}>Publish for contest</button></div></div> : <p className="product-empty">Start an import to see its result here.</p>}</section></div><section className="organizer-product-section"><h2>Published collections</h2>{data.collections.map((collection) => <article className="collection-summary" key={collection.snapshotId}><div><span>{collection.mode} · {collection.status}</span><strong>{collection.repository.owner}/{collection.repository.name}</strong><small>{collection.problems.length} problems</small></div><div>{collection.problems.slice(0, 4).map((problem) => <span key={problem.id}>{problem.number}. {problem.title["zh-TW"] ?? problem.title.en ?? problem.slug}</span>)}</div></article>)}{data.collections.length === 0 && <p className="product-empty">No published collections yet.</p>}</section>{message && <output className="product-message">{message}</output>}</div>;
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

export function OrganizerContests() { return <OrganizerGate><ContestsContent /></OrganizerGate>; }

function ContestsContent() {
  const { data, error } = useOrganizerCollections();
  const problems = useMemo(() => data.collections.filter((collection) => collection.mode === "contest" && collection.status === "published").flatMap((collection) => collection.problems.map((problem) => ({ ...problem, collection: `${collection.repository.owner}/${collection.repository.name}` }))), [data.collections]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [accessMode, setAccessMode] = useState<"public" | "invite">("public"); const [inviteCode, setInviteCode] = useState(""); const [startsAt, setStartsAt] = useState(""); const [endsAt, setEndsAt] = useState(""); const [freezeAt, setFreezeAt] = useState("");
  const [createdId, setCreatedId] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const filtered = problems.filter((problem) => `${problem.number} ${problem.slug} ${Object.values(problem.title).join(" ")} ${problem.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  function toggle(id: string) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function move(index: number, direction: -1 | 1) { setSelected((current) => { const next = [...current]; const other = index + direction; if (other < 0 || other >= next.length) return current; [next[index], next[other]] = [next[other], next[index]]; return next; }); }
  async function create(event: FormEvent) { event.preventDefault(); setBusy(true); setMessage(""); try { const result = await post<{ contestId: string }>("/api/contests", { title, description, accessMode, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), ...(freezeAt ? { freezeAt: new Date(freezeAt).toISOString() } : {}), ...(accessMode === "invite" ? { inviteCode } : {}), problemVersionIds: selected }); setCreatedId(result.contestId); setMessage("Contest draft created. Review it before publishing."); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  async function publish() { setBusy(true); try { await post(`/api/contests/${createdId}/publish`, {}); setMessage("Contest published."); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  return <div className="product-page"><header className="product-page-header"><span className="product-eyebrow"><Trophy size={14} /> Organizer</span><h1>Contest builder</h1><p>Choose published contest problems, arrange their order, and set the schedule.</p></header>{error && <div className="product-error">{error}</div>}<form className="contest-builder" onSubmit={(event) => void create(event)}><section className="organizer-panel organizer-product-form"><h2>Contest details</h2><label>Title<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Description<textarea maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>Access<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as typeof accessMode)}><option value="public">Public</option><option value="invite">Invite code</option></select></label>{accessMode === "invite" && <label>Invite code<input required minLength={16} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /></label>}<div className="organizer-date-grid"><label>Starts<input type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label>Ends<input type="datetime-local" required value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label><label>Freeze<input type="datetime-local" value={freezeAt} onChange={(event) => setFreezeAt(event.target.value)} /></label></div></section><section className="organizer-panel problem-picker"><h2>Problems</h2><label className="catalog-search"><Search size={15} /><input value={search} placeholder="Search published contest problems…" onChange={(event) => setSearch(event.target.value)} /></label><div className="problem-picker-list">{filtered.map((problem) => <button type="button" className={selected.includes(problem.id) ? "is-selected" : ""} key={problem.id} onClick={() => toggle(problem.id)}><span>{problem.number}</span><div><strong>{problem.title["zh-TW"] ?? problem.title.en ?? problem.slug}</strong><small>{problem.collection}</small></div>{selected.includes(problem.id) && <Check size={15} />}</button>)}</div><h3>Order</h3>{selected.map((id, index) => { const problem = problems.find((item) => item.id === id); return <div className="selected-problem" key={id}><span>{index + 1}</span><strong>{problem?.title["zh-TW"] ?? problem?.title.en ?? problem?.slug}</strong><button type="button" onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div>; })}<button className="primary-action" disabled={busy || selected.length === 0}>Create contest draft</button>{createdId && <div className="organizer-actions"><button type="button" className="primary-action" disabled={busy} onClick={() => void publish()}>Publish contest</button><Link href={`/contests/${createdId}`}>Preview <ChevronRight size={14} /></Link></div>}</section></form>{message && <output className="product-message">{message}</output>}</div>;
}

export function OrganizerRejudges() { return <OrganizerGate><RejudgesContent /></OrganizerGate>; }

function RejudgesContent() {
  const { data, error } = useOrganizerCollections();
  const problems = data.collections.filter((collection) => ["published", "superseded"].includes(collection.status)).flatMap((collection) => collection.problems.map((problem) => ({ ...problem, label: `${collection.repository.name} · ${problem.number}. ${problem.title["zh-TW"] ?? problem.title.en ?? problem.slug}` })));
  const [oldId, setOldId] = useState(""); const [newId, setNewId] = useState(""); const [batch, setBatch] = useState<{ id: string; status: string; completedCount: number; expectedCount: number; failedCount: number }>(); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function create(event: FormEvent) { event.preventDefault(); setBusy(true); try { const result = await post<{ rejudgeBatchId: string; status: string }>("/api/organizer/rejudges", { oldProblemVersionId: oldId, newProblemVersionId: newId, idempotencyKey: crypto.randomUUID() }); setBatch({ id: result.rejudgeBatchId, status: result.status, completedCount: 0, expectedCount: 0, failedCount: 0 }); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  async function refresh() { if (!batch) return; try { const result = await forgeJson<{ rejudgeBatch: typeof batch }>(`/api/organizer/rejudges/${batch.id}`); setBatch(result.rejudgeBatch); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } }
  return <div className="product-page narrow-page"><header className="product-page-header"><span className="product-eyebrow"><Send size={14} /> Organizer</span><h1>Rejudge</h1><p>Move existing verified submissions from one published problem version to a newer version.</p></header>{error && <div className="product-error">{error}</div>}<form className="organizer-panel organizer-product-form" onSubmit={(event) => void create(event)}><label>Current problem version<select required value={oldId} onChange={(event) => setOldId(event.target.value)}><option value="">Choose a problem…</option>{problems.map((problem) => <option key={problem.id} value={problem.id}>{problem.label}</option>)}</select></label><label>New problem version<select required value={newId} onChange={(event) => setNewId(event.target.value)}><option value="">Choose its replacement…</option>{problems.filter((problem) => problem.id !== oldId).map((problem) => <option key={problem.id} value={problem.id}>{problem.label}</option>)}</select></label><button className="primary-action" disabled={busy || oldId === newId}>Start rejudge</button>{batch && <div className="rejudge-progress"><strong>{batch.status}</strong><span>{batch.completedCount}/{batch.expectedCount} complete · {batch.failedCount} failed</span><button type="button" onClick={() => void refresh()}>Refresh</button></div>}</form>{message && <output className="product-message">{message}</output>}</div>;
}
