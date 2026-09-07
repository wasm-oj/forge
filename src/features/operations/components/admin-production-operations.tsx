"use client";

import { Activity, CheckCircle2, LockKeyhole, RotateCw, ShieldAlert, UnlockKeyhole } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";

const RESUME_REASON = "repository-source-truth-production-smoke-passed";
const CUTOVER_REASON = "repository-source-truth-cutover";

interface FormalMutationStatus {
  readonly enabled: boolean;
  readonly reason: string;
  readonly updatedAt: string;
}

interface ContainerProbe {
  readonly ready: boolean;
  readonly buildId: string;
  readonly contract: number;
  readonly protocol: string;
  readonly workerVersionId: string;
}

export function ContainerProbePanel({ result, error, checking, disabled, onCheck }: {
  readonly result?: ContainerProbe;
  readonly error: string;
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly onCheck: () => void;
}) {
  return <section className="organizer-panel">
    <h2><Activity size={17} /> Container</h2>
    <p>Check Container starts a judge Container and verifies that its build and protocol match the Worker.</p>
    <button className="secondary-action" type="button" disabled={disabled} onClick={onCheck}><CheckCircle2 size={15} /> {checking ? "Checking Container…" : "Check Container"}</button>
    {error && <p className="product-error" role="alert">{error}</p>}
    {result && <div role="status">
      <p>{result.ready ? "Container is ready and matches the Worker." : "Container is not ready."}</p>
      <p>Build <code>{result.buildId}</code></p>
      <details><summary>Container details</summary><dl><dt>Contract</dt><dd>{result.contract}</dd><dt>Protocol</dt><dd>{result.protocol}</dd><dt>Worker version</dt><dd>{result.workerVersionId}</dd></dl></details>
    </div>}
  </section>;
}

export function AdminProductionOperations() {
  const { locale, session, sessionStatus } = useProduct();
  usePageTitle(locale === "zh-TW" ? "正式環境操作" : "Production operations");
  const admin = session?.authenticated === true && session.user?.roles.includes("admin") === true;
  const [control, setControl] = useState<FormalMutationStatus>();
  const [ready, setReady] = useState(false);
  const [containerProbe, setContainerProbe] = useState<ContainerProbe>();
  const [containerError, setContainerError] = useState("");
  const [checkingContainer, setCheckingContainer] = useState(false);
  const [resumeConfirmation, setResumeConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [nextControl, readinessResponse] = await Promise.all([
        wasmOjJson<FormalMutationStatus>("/api/admin/formal-mutations"),
        fetch("/api/health/ready", { credentials: "same-origin", cache: "no-store" }),
      ]);
      const readiness = await readinessResponse.json() as { ready?: unknown };
      setControl(nextControl);
      setReady(readinessResponse.ok && readiness.ready === true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);

  useEffect(() => { if (admin) queueMicrotask(() => void refresh()); }, [admin, refresh]);

  async function checkContainer() {
    setBusy(true); setCheckingContainer(true); setContainerError(""); setContainerProbe(undefined);
    try { setContainerProbe(await wasmOjMutation<ContainerProbe>("/api/admin/container-probe", {})); }
    catch (reason) { setContainerError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); setCheckingContainer(false); }
  }

  async function changeGate(enabled: boolean) {
    setBusy(true); setMessage(""); setError("");
    try {
      const next = await wasmOjMutation<FormalMutationStatus>(
        enabled ? "/api/admin/formal-mutations/resume" : "/api/admin/formal-mutations/pause",
        { reason: enabled ? RESUME_REASON : CUTOVER_REASON },
      );
      setControl(next);
      if (enabled) setResumeConfirmation("");
      setMessage(enabled ? "Formal mutations resumed after repository, submission, and stale-projection smoke." : "Formal mutations paused.");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  if (sessionStatus !== "ready") return null;
  if (!admin) return <main className="product-page" id="main-content"><div className="product-error" role="alert">An Admin role is required.</div></main>;

  return <main className="product-page operations-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><ShieldAlert size={14} /> Admin</span><h1>Production operations</h1><p>Readiness verifies the database and Worker build. Use Check Container to verify the judge Container.</p></header>
    {error && <div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry status</button></div>}
    <section className="operations-status" aria-label="Production status">
      <article><Activity size={18} /><span>Readiness</span><strong>{ready ? "Ready" : "Not ready"}</strong></article>
      <article>{control?.enabled ? <UnlockKeyhole size={18} /> : <LockKeyhole size={18} />}<span>Formal mutations</span><strong>{control ? control.enabled ? "Enabled" : "Paused" : "Unavailable"}</strong></article>
      <article><CheckCircle2 size={18} /><span>Container</span><strong>{checkingContainer ? "Checking…" : containerError ? "Check failed" : containerProbe ? containerProbe.ready ? "Ready" : "Not ready" : "Not checked"}</strong></article>
    </section>
    <div className="operations-grid">
      <section className="organizer-panel"><h2><ShieldAlert size={17} /> Maintenance access</h2><p>During a production pause for <code>{CUTOVER_REASON}</code>, your existing Admin session permits catalog sync and code Official Submit checks. Catalog ownership and submission limits still apply; other formal mutations remain paused.</p><div className="organizer-actions"><Link className="secondary-action" href="/organizer/catalogs">Catalog sync</Link><Link className="secondary-action" href="/problems">Problems</Link></div></section>
      <ContainerProbePanel result={containerProbe} error={containerError} checking={checkingContainer} disabled={busy} onCheck={() => void checkContainer()} />
      <section className="organizer-panel"><h2><LockKeyhole size={17} /> Mutation gate</h2><p>Pause for the one-time migration. Resume only after exact-commit content, submission, and stale-projection smoke pass.</p>{control && <p><strong>{control.enabled ? "Enabled" : "Paused"}</strong> · {control.reason}<br /><small>{new Date(control.updatedAt).toLocaleString()}</small></p>}<button className="secondary-action" type="button" disabled={busy || control?.enabled !== true} onClick={() => void changeGate(false)}><LockKeyhole size={15} /> Pause for cutover</button><label className="operations-field">Type the exact smoke completion reason<input type="text" autoComplete="off" value={resumeConfirmation} disabled={busy || control?.enabled !== false} onChange={(event) => setResumeConfirmation(event.target.value)} /></label><code>{RESUME_REASON}</code><button className="danger-action" type="button" disabled={busy || control?.enabled !== false || !ready || resumeConfirmation !== RESUME_REASON} onClick={() => void changeGate(true)}><UnlockKeyhole size={15} /> Resume formal mutations</button></section>
    </div>
    <button className="secondary-action" type="button" disabled={busy} onClick={() => void refresh()}><RotateCw size={15} /> Refresh status</button>
    {message && <output className="product-message">{message}</output>}
  </main>;
}
