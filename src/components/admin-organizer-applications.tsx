"use client";

import { Check, Clock3, ShieldCheck, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { forgeJson, forgeMutation } from "./online-api";

type Status = "pending" | "approved" | "rejected";
interface Application {
  readonly id: string;
  readonly user_id: string;
  readonly statement: string;
  readonly status: Status;
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly login: string;
  readonly avatar_url: string;
}

export function AdminOrganizerApplications() {
  const [status, setStatus] = useState<Status>("pending");
  const [applications, setApplications] = useState<readonly Application[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await forgeJson<{ applications: readonly Application[] }>(`/api/admin/organizer-applications?status=${status}`);
    setApplications(result.applications);
  }, [status]);
  useEffect(() => {
    let active = true;
    void forgeJson<{ applications: readonly Application[] }>(`/api/admin/organizer-applications?status=${status}`)
      .then((result) => { if (active) setApplications(result.applications); })
      .catch((reason: unknown) => { if (active) setMessage(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [status]);
  async function review(id: string, decision: "approved" | "rejected") {
    setBusy(true); setMessage("");
    try { await forgeMutation(`/api/admin/organizer-applications/${encodeURIComponent(id)}/review`, { decision }); await load(); setMessage(`Application ${decision}.`); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><ShieldCheck size={14} /> Admin</span><h1>Organizer applications</h1><p>Review who may connect repositories and publish collections.</p></header><div className="admin-tabs">{(["pending", "approved", "rejected"] as const).map((value) => <button className={status === value ? "is-active" : ""} type="button" key={value} onClick={() => setStatus(value)}>{value}</button>)}</div><div className="application-list">{applications.map((application) => <article className="application-card" key={application.id}><header><Image src={application.avatar_url} alt="" width={40} height={40} unoptimized /><div><strong>@{application.login}</strong><span><Clock3 size={12} />{new Date(application.created_at).toLocaleString()}</span></div><span className={`application-status ${application.status}`}>{application.status}</span></header><p>{application.statement}</p>{application.status === "pending" && <footer><button type="button" className="reject-action" disabled={busy} onClick={() => void review(application.id, "rejected")}><X size={15} />Reject</button><button type="button" className="approve-action" disabled={busy} onClick={() => void review(application.id, "approved")}><Check size={15} />Approve</button></footer>}</article>)}{applications.length === 0 && <div className="product-empty large">No {status} applications.</div>}</div>{message && <output className="product-message">{message}</output>}</main>;
}
