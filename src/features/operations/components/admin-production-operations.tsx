"use client";

import { Activity, CheckCircle2, LockKeyhole, RotateCw, ShieldAlert, UnlockKeyhole } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  configureWasmOjMaintenanceSmokeToken,
  wasmOjJson,
  wasmOjMaintenanceSmokeArmed,
  wasmOjMutation,
} from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";

const RESUME_REASON = "repository-source-truth-production-smoke-passed";

interface FormalMutationStatus {
  readonly enabled: boolean;
  readonly reason: string;
  readonly updatedAt: string;
}

export function AdminProductionOperations() {
  const { locale, session, sessionStatus } = useProduct();
  usePageTitle(locale === "zh-TW" ? "正式環境操作" : "Production operations");
  const admin = session?.user?.roles.includes("admin") ?? false;
  const [control, setControl] = useState<FormalMutationStatus>();
  const [ready, setReady] = useState(false);
  const [smokeToken, setSmokeToken] = useState("");
  const [smokeArmed, setSmokeArmed] = useState(wasmOjMaintenanceSmokeArmed);
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

  function armSmokeLane() {
    setMessage(""); setError("");
    try { configureWasmOjMaintenanceSmokeToken(smokeToken); setSmokeToken(""); setSmokeArmed(true); setMessage("Maintenance smoke header armed in memory for this browser tab."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function clearSmokeLane() {
    configureWasmOjMaintenanceSmokeToken(); setSmokeToken(""); setSmokeArmed(false); setMessage("Maintenance smoke header cleared.");
  }

  async function changeGate(enabled: boolean) {
    setBusy(true); setMessage(""); setError("");
    try {
      const next = await wasmOjMutation<FormalMutationStatus>(
        enabled ? "/api/admin/formal-mutations/resume" : "/api/admin/formal-mutations/pause",
        { reason: enabled ? RESUME_REASON : "repository-source-truth-cutover" },
      );
      setControl(next);
      if (enabled) { configureWasmOjMaintenanceSmokeToken(); setSmokeArmed(false); setResumeConfirmation(""); }
      setMessage(enabled ? "Formal mutations resumed after repository, submission, and stale-projection smoke." : "Formal mutations paused.");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  if (sessionStatus !== "ready") return null;
  if (!admin) return <main className="product-page" id="main-content"><div className="product-error" role="alert">An Admin role is required.</div></main>;

  return <main className="product-page operations-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><ShieldAlert size={14} /> Admin</span><h1>Production operations</h1><p>Readiness verifies D1 plus the Worker version tag/build ID. Container build and protocol are checked by the deployment probe.</p></header>
    {error && <div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry status</button></div>}
    <section className="operations-status" aria-label="Production status">
      <article><Activity size={18} /><span>Readiness</span><strong>{ready ? "Ready" : "Not ready"}</strong></article>
      <article>{control?.enabled ? <UnlockKeyhole size={18} /> : <LockKeyhole size={18} />}<span>Formal mutations</span><strong>{control ? control.enabled ? "Enabled" : "Paused" : "Unavailable"}</strong></article>
      <article><CheckCircle2 size={18} /><span>Smoke lane</span><strong>{smokeArmed ? "Armed in memory" : "Disarmed"}</strong></article>
    </section>
    <div className="operations-grid">
      <section className="organizer-panel"><h2><ShieldAlert size={17} /> Maintenance smoke lane</h2><p>The token stays in this tab and is attached only to mutation smoke requests.</p><label className="operations-field">Maintenance smoke token<input type="password" autoComplete="off" minLength={32} maxLength={256} value={smokeToken} disabled={busy} onChange={(event) => setSmokeToken(event.target.value)} /></label><div className="organizer-actions"><button className="secondary-action" type="button" disabled={busy || smokeToken.length < 32} onClick={armSmokeLane}>Arm in memory</button><button className="secondary-action" type="button" disabled={busy || !smokeArmed} onClick={clearSmokeLane}>Clear token</button><Link className="secondary-action" href="/organizer/catalogs">Catalog smoke</Link><Link className="secondary-action" href="/problems">Judge smoke</Link></div></section>
      <section className="organizer-panel"><h2><LockKeyhole size={17} /> Mutation gate</h2><p>Pause for the one-time migration. Resume only after exact-commit content, submission, and stale-projection smoke pass.</p>{control && <p><strong>{control.enabled ? "Enabled" : "Paused"}</strong> · {control.reason}<br /><small>{new Date(control.updatedAt).toLocaleString()}</small></p>}<button className="secondary-action" type="button" disabled={busy || control?.enabled !== true} onClick={() => void changeGate(false)}><LockKeyhole size={15} /> Pause for cutover</button><label className="operations-field">Type the exact smoke completion reason<input type="text" autoComplete="off" value={resumeConfirmation} disabled={busy || control?.enabled !== false} onChange={(event) => setResumeConfirmation(event.target.value)} /></label><code>{RESUME_REASON}</code><button className="danger-action" type="button" disabled={busy || control?.enabled !== false || !ready || resumeConfirmation !== RESUME_REASON} onClick={() => void changeGate(true)}><UnlockKeyhole size={15} /> Resume formal mutations</button></section>
    </div>
    <button className="secondary-action" type="button" disabled={busy} onClick={() => void refresh()}><RotateCw size={15} /> Refresh status</button>
    {message && <output className="product-message">{message}</output>}
  </main>;
}
