"use client";

import { Check, Clock3, ShieldCheck, TriangleAlert, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProduct } from "./app-shell";
import { Drawer } from "./drawer";
import { IconButton } from "./icon-button";
import { forgeJson, forgeMutation } from "./online-api";
import { usePageTitle } from "./page-title";

type Status = "pending" | "approved" | "rejected";
interface Application {
  readonly id: string;
  readonly user_id: string;
  readonly statement: string;
  readonly status: Status;
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly review_note: string | null;
  readonly login: string;
  readonly avatar_url: string;
  readonly organizer_role_active: number;
  readonly admin_role_active: number;
}
type AdminAction = { readonly type: "approve" | "reject" | "revoke"; readonly application: Application };

export function AdminOrganizerApplications() {
  const { locale } = useProduct();
  usePageTitle(locale === "zh-TW" ? "Organizer 申請管理" : "Organizer applications");
  const [status, setStatus] = useState<Status>("pending");
  const [applications, setApplications] = useState<readonly Application[]>([]);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<AdminAction>();
  const [rejectReason, setRejectReason] = useState("");
  const actionReturnRef = useRef<HTMLButtonElement>(null);
  const rejectReasonRef = useRef<HTMLTextAreaElement>(null);
  const load = useCallback(async () => {
    try {
      const result = await forgeJson<{ applications: readonly Application[] }>(`/api/admin/organizer-applications?status=${status}`);
      setApplications(result.applications);
      setLoadError("");
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [status]);
  useEffect(() => {
    let active = true;
    void forgeJson<{ applications: readonly Application[] }>(`/api/admin/organizer-applications?status=${status}`)
      .then((result) => { if (active) setApplications(result.applications); })
      .catch((reason: unknown) => { if (active) setLoadError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [status]);
  function openAction(next: AdminAction, trigger: HTMLButtonElement) {
    actionReturnRef.current = trigger;
    setRejectReason("");
    setMessage("");
    setAction(next);
  }
  function closeAction() {
    if (!busy) setAction(undefined);
  }
  async function confirmAction() {
    if (!action) return;
    const reason = rejectReason.trim();
    if (action.type === "reject" && (reason.length < 10 || reason.length > 1_000)) {
      setMessage("Rejection reason must contain 10–1,000 characters.");
      return;
    }
    setBusy(true); setMessage("");
    try {
      if (action.type === "revoke") {
        await forgeMutation(`/api/admin/organizers/${encodeURIComponent(action.application.user_id)}/revoke`, {});
        setMessage(`Organizer role removed for @${action.application.login}.`);
      } else {
        await forgeMutation(`/api/admin/organizer-applications/${encodeURIComponent(action.application.id)}/review`, { decision: action.type === "approve" ? "approved" : "rejected", ...(action.type === "reject" ? { reason } : {}) });
        setMessage(`Application ${action.type === "approve" ? "approved" : "rejected"}.`);
      }
      setAction(undefined);
      await load();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const actionTitle = action?.type === "approve" ? "Approve Organizer" : action?.type === "reject" ? "Reject application" : "Revoke Organizer role";
  return <><main className="product-page" id="main-content" data-drawer-background><header className="product-page-header"><span className="product-eyebrow"><ShieldCheck size={14} /> Admin</span><h1>Organizer applications</h1><p>Review who may connect repositories and publish collections.</p></header>{loadError && <div className="product-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>Retry</button></div>}<div className="admin-tabs">{(["pending", "approved", "rejected"] as const).map((value) => <button className={status === value ? "is-active" : ""} type="button" key={value} onClick={() => setStatus(value)}>{value}</button>)}</div><div className="application-list">{applications.map((application) => <article className="application-card" key={application.id}><header><Image src={application.avatar_url} alt="" width={40} height={40} unoptimized /><div><strong>@{application.login}</strong><span><Clock3 size={12} />{new Date(application.created_at).toLocaleString()}</span></div><span className={`application-status ${application.status}`}>{application.status === "approved" ? application.admin_role_active ? "Admin access" : application.organizer_role_active ? "Active" : "Revoked" : application.status}</span></header><p>{application.statement}</p>{application.review_note && <p><strong>Review reason:</strong> {application.review_note}</p>}{application.status === "pending" && <footer><button type="button" className="reject-action" disabled={busy} onClick={(event) => openAction({ type: "reject", application }, event.currentTarget)}><X size={15} />Reject</button><button type="button" className="approve-action" disabled={busy} onClick={(event) => openAction({ type: "approve", application }, event.currentTarget)}><Check size={15} />Approve</button></footer>}{application.status === "approved" && application.organizer_role_active === 1 && application.admin_role_active !== 1 && <footer><button type="button" className="reject-action" disabled={busy} onClick={(event) => openAction({ type: "revoke", application }, event.currentTarget)}><X size={15} />Revoke role</button></footer>}</article>)}{applications.length === 0 && !loadError && <div className="product-empty large">No {status} applications.</div>}</div>{message && <output className="product-message">{message}</output>}</main><Drawer open={Boolean(action)} label={actionTitle} onClose={closeAction} returnFocusRef={actionReturnRef} initialFocusRef={action?.type === "reject" ? rejectReasonRef : undefined}><div className="account-delete-drawer organizer-product-form"><header><div><span className="product-eyebrow"><TriangleAlert aria-hidden="true" size={14} /> Admin confirmation</span><h2>{actionTitle}</h2></div><IconButton icon={X} label="Close confirmation" disabled={busy} onClick={closeAction} /></header>{action && <><p>{action.type === "approve" ? `Approve @${action.application.login}? They will be able to connect repositories, publish collections, create contests, and start rejudges.` : action.type === "reject" ? `Explain why @${action.application.login} is not approved. This reason is shown to the applicant.` : `Remove only the Organizer role from @${action.application.login}? Their account and existing published resources remain; new Organizer mutations will be blocked.`}</p>{action.type === "reject" && <label>Reason<textarea ref={rejectReasonRef} required minLength={10} maxLength={1_000} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} /></label>}{message && <div className="product-error" role="alert"><span>{message}</span></div>}<footer><button type="button" className="secondary-action" disabled={busy} onClick={closeAction}>Cancel</button><button type="button" className={action.type === "approve" ? "primary-action" : "danger-action"} disabled={busy || (action.type === "reject" && (rejectReason.trim().length < 10 || rejectReason.trim().length > 1_000))} onClick={() => void confirmAction()}>{action.type === "approve" ? <><Check size={15} />Approve</> : action.type === "reject" ? <><X size={15} />Reject</> : <><X size={15} />Revoke role</>}</button></footer></>}</div></Drawer></>;
}
