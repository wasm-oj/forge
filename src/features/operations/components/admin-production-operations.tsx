"use client";

import { Activity, CheckCircle2, FileKey2, LockKeyhole, RotateCw, ShieldAlert, UnlockKeyhole } from "lucide-react";
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

const MAX_ACTIVATION_REQUEST_BYTES = 300 * 1024;
const RESUME_REASON = "architecture-v2-production-smoke-passed";

interface FormalMutationStatus {
  readonly enabled: boolean;
  readonly reason: string;
  readonly updatedAt: string;
}

interface ActivationRequest {
  readonly expectedCurrentReleaseId: string | null;
  readonly manifest: Record<string, unknown>;
}

export function parseAdminActivationRequest(value: unknown): ActivationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Activation request must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["expectedCurrentReleaseId", "manifest"].sort().join("\0")) {
    throw new TypeError("Activation request has an invalid shape.");
  }
  if (record.expectedCurrentReleaseId !== null && typeof record.expectedCurrentReleaseId !== "string") {
    throw new TypeError("Activation request has an invalid current-release fence.");
  }
  if (!record.manifest || typeof record.manifest !== "object" || Array.isArray(record.manifest)) {
    throw new TypeError("Activation request manifest must be an object.");
  }
  return {
    expectedCurrentReleaseId: record.expectedCurrentReleaseId as string | null,
    manifest: record.manifest as Record<string, unknown>,
  };
}

export function AdminProductionOperations() {
  const { locale, session, sessionStatus } = useProduct();
  usePageTitle(locale === "zh-TW" ? "正式環境操作" : "Production operations");
  const admin = session?.user?.roles.includes("admin") ?? false;
  const [control, setControl] = useState<FormalMutationStatus>();
  const [ready, setReady] = useState(false);
  const [activation, setActivation] = useState<ActivationRequest>();
  const [activationName, setActivationName] = useState("");
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!admin) return;
    queueMicrotask(() => void refresh());
  }, [admin, refresh]);

  async function loadActivationFile(file?: File) {
    setActivation(undefined);
    setActivationName("");
    setMessage("");
    setError("");
    if (!file) return;
    try {
      if (file.size < 2 || file.size > MAX_ACTIVATION_REQUEST_BYTES) {
        throw new RangeError("Activation request must contain 2–307,200 bytes.");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const parsed = parseAdminActivationRequest(JSON.parse(text) as unknown);
      setActivation(parsed);
      setActivationName(file.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function armSmokeLane() {
    setMessage("");
    setError("");
    try {
      configureWasmOjMaintenanceSmokeToken(smokeToken);
      setSmokeToken("");
      setSmokeArmed(true);
      setMessage("Maintenance smoke header armed in memory for this browser tab.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function clearSmokeLane() {
    configureWasmOjMaintenanceSmokeToken();
    setSmokeToken("");
    setSmokeArmed(false);
    setMessage("Maintenance smoke header cleared.");
  }

  async function activate() {
    if (!activation) return;
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await wasmOjMutation<{ release: { id: string; manifestSha256: string; status: string } }>(
        "/api/admin/releases/activate",
        activation,
      );
      setMessage(`Release ${result.release.id} is ${result.release.status}.`);
      setActivation(undefined);
      setActivationName("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function changeGate(enabled: boolean) {
    setBusy(true); setMessage(""); setError("");
    try {
      const reason = enabled ? RESUME_REASON : "architecture-v2-cutover";
      const next = await wasmOjMutation<FormalMutationStatus>(
        enabled ? "/api/admin/formal-mutations/resume" : "/api/admin/formal-mutations/pause",
        { reason },
      );
      setControl(next);
      if (enabled) {
        configureWasmOjMaintenanceSmokeToken();
        setSmokeArmed(false);
        setResumeConfirmation("");
      }
      setMessage(enabled ? "Formal mutations resumed on the exact active release." : "Formal mutations paused.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (sessionStatus !== "ready") return null;
  if (!admin) return <main className="product-page" id="main-content"><div className="product-error" role="alert">An Admin role is required.</div></main>;

  const manifestReleaseId = typeof activation?.manifest.releaseId === "string" ? activation.manifest.releaseId : undefined;
  return <main className="product-page operations-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><ShieldAlert size={14} /> Admin</span><h1>Production operations</h1><p>Fail-closed release activation and maintenance smoke controls. Secrets remain in memory and are cleared on reload.</p></header>
    {error && <div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry status</button></div>}
    <section className="operations-status" aria-label="Production status">
      <article><Activity size={18} /><span>Readiness</span><strong>{ready ? "Ready" : "Not ready"}</strong></article>
      <article>{control?.enabled ? <UnlockKeyhole size={18} /> : <LockKeyhole size={18} />}<span>Formal mutations</span><strong>{control ? control.enabled ? "Enabled" : "Paused" : "Unavailable"}</strong></article>
      <article><CheckCircle2 size={18} /><span>Smoke lane</span><strong>{smokeArmed ? "Armed in memory" : "Disarmed"}</strong></article>
    </section>

    <div className="operations-grid">
      <section className="organizer-panel"><h2><FileKey2 size={17} /> Activate exact release</h2><p>Choose the canonical activation request generated for this deployed Worker and Container. The file is parsed in memory and never uploaded anywhere except the authenticated activation API.</p><label className="operations-field">Activation request JSON<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void loadActivationFile(event.currentTarget.files?.[0])} /></label>{activation && <dl className="operations-summary"><div><dt>File</dt><dd>{activationName}</dd></div><div><dt>Release</dt><dd>{manifestReleaseId ?? "Invalid manifest identity"}</dd></div><div><dt>Expected current</dt><dd>{activation.expectedCurrentReleaseId ?? "None (architecture reset)"}</dd></div></dl>}<button className="primary-action" type="button" disabled={busy || !activation || control?.enabled !== false || !manifestReleaseId} onClick={() => void activate()}><FileKey2 size={15} /> Activate release</button></section>

      <section className="organizer-panel"><h2><ShieldAlert size={17} /> Maintenance smoke lane</h2><p>Paste the short-lived token once. It is attached only by this tab&apos;s mutation clients and is never written to local or session storage.</p><label className="operations-field">Maintenance smoke token<input type="password" autoComplete="off" minLength={32} maxLength={256} value={smokeToken} disabled={busy} onChange={(event) => setSmokeToken(event.target.value)} /></label><div className="organizer-actions"><button className="secondary-action" type="button" disabled={busy || smokeToken.length < 32} onClick={armSmokeLane}>Arm in memory</button><button className="secondary-action" type="button" disabled={busy || !smokeArmed} onClick={clearSmokeLane}>Clear token</button><Link className="secondary-action" href="/organizer/collections">Catalog smoke</Link><Link className="secondary-action" href="/problems">Judge smoke</Link></div></section>

      <section className="organizer-panel"><h2><LockKeyhole size={17} /> Mutation gate</h2><p>Pause before destructive maintenance. Resume is permitted only when readiness confirms that D1&apos;s active release exactly matches the deployed Worker identity.</p>{control && <p><strong>{control.enabled ? "Enabled" : "Paused"}</strong> · {control.reason}<br /><small>{new Date(control.updatedAt).toLocaleString()}</small></p>}<button className="secondary-action" type="button" disabled={busy || control?.enabled !== true} onClick={() => void changeGate(false)}><LockKeyhole size={15} /> Pause for v2 cutover</button><label className="operations-field">Type the exact smoke completion reason<input type="text" autoComplete="off" value={resumeConfirmation} disabled={busy || control?.enabled !== false} onChange={(event) => setResumeConfirmation(event.target.value)} /></label><code>{RESUME_REASON}</code><button className="danger-action" type="button" disabled={busy || control?.enabled !== false || !ready || resumeConfirmation !== RESUME_REASON} onClick={() => void changeGate(true)}><UnlockKeyhole size={15} /> Resume formal mutations</button></section>
    </div>
    <button className="secondary-action" type="button" disabled={busy} onClick={() => void refresh()}><RotateCw size={15} /> Refresh status</button>
    {message && <output className="product-message">{message}</output>}
  </main>;
}
