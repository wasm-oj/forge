"use client";

import { CheckCircle2, GitBranch, LoaderCircle, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";

interface CliLoginFlow {
  readonly flowId: string;
  readonly deviceName: string;
  readonly expiresAt: string;
  readonly state: "pending" | "approved" | "complete" | "expired";
  readonly approvedByCurrentUser: boolean;
}

type FlowState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly flow: CliLoginFlow }
  | { readonly status: "error"; readonly message: string };

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TEXT = {
  en: {
    title: "Authorize woj CLI", eyebrow: "CLI sign-in", intro: "Confirm the terminal that requested access before connecting your WASM-OJ account.",
    signInTitle: "Sign in to continue", signInDetail: "GitHub sign-in lets you review the requesting device before granting access.", signIn: "Sign in with GitHub",
    loading: "Loading CLI request…", invalid: "This CLI login link is invalid.", retry: "Retry", device: "Requesting device", account: "WASM-OJ account",
    access: "The CLI can perform its supported Student and Organizer commands as this account. Roles are checked again by the server on every request; browser-only account and Admin controls are not granted.",
    approve: "Authorize this CLI", approving: "Authorizing…", approved: "CLI authorized", approvedDetail: "Return to the terminal. It will finish signing in automatically.",
    complete: "This request is complete", completeDetail: "The access token has already been issued. You can close this page.",
    expired: "This request expired", expiredDetail: "Start `woj auth login` again to create a new verification link.", different: "This request was approved by another account.",
  },
  "zh-TW": {
    title: "授權 woj CLI", eyebrow: "CLI 登入", intro: "連結 WASM-OJ 帳號前，請先確認是哪一個終端機提出存取要求。",
    signInTitle: "登入後繼續", signInDetail: "使用 GitHub 登入後，你可以先確認要求授權的裝置。", signIn: "使用 GitHub 登入",
    loading: "正在載入 CLI 要求…", invalid: "這個 CLI 登入連結無效。", retry: "重試", device: "要求授權的裝置", account: "WASM-OJ 帳號",
    access: "CLI 將能以此帳號執行其支援的 Student 與 Organizer 指令；伺服器會在每次要求時重新檢查角色，且不授予僅限瀏覽器的帳號與 Admin 控制權。",
    approve: "授權這個 CLI", approving: "正在授權…", approved: "CLI 已授權", approvedDetail: "請回到終端機；CLI 會自動完成登入。",
    complete: "這個要求已完成", completeDetail: "存取權杖已經核發，可以關閉此頁面。",
    expired: "這個要求已過期", expiredDetail: "請重新執行 `woj auth login` 取得新的驗證連結。", different: "這個要求已由另一個帳號核准。",
  },
} as const;

export function CliAuthApproval({ flowId }: { readonly flowId: string }) {
  const { locale, session, sessionStatus } = useProduct();
  const text = TEXT[locale];
  const [flowState, setFlowState] = useState<FlowState>({ status: "idle" });
  const [approving, setApproving] = useState(false);
  const valid = FLOW_ID.test(flowId);
  usePageTitle(text.title);

  const load = useCallback(async () => {
    if (!FLOW_ID.test(flowId)) {
      setFlowState({ status: "error", message: text.invalid });
      return;
    }
    setFlowState({ status: "loading" });
    try {
      const flow = await wasmOjJson<CliLoginFlow>(`/api/auth/cli/flows/${encodeURIComponent(flowId)}`);
      setFlowState({ status: "ready", flow });
    } catch (error) {
      setFlowState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [flowId, text.invalid]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !session?.authenticated) return;
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load, session?.authenticated, sessionStatus]);

  async function approve() {
    setApproving(true);
    try {
      await wasmOjMutation(`/api/auth/cli/flows/${encodeURIComponent(flowId)}/approve`, {});
      await load();
    } catch (error) {
      setFlowState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setApproving(false);
    }
  }

  const returnPath = `/auth/cli?flow=${encodeURIComponent(flowId)}`;
  return <main className="product-page narrow-page cli-auth-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><MonitorSmartphone aria-hidden="true" size={14} /> {text.eyebrow}</span><h1>{text.title}</h1><p>{text.intro}</p></header>
    {!valid && <div className="product-error" role="alert"><span>{text.invalid}</span></div>}
    {valid && sessionStatus === "error" && <div className="product-error" role="alert"><span>{text.invalid}</span></div>}
    {valid && sessionStatus === "ready" && !session?.authenticated && <section className="sign-in-empty"><GitBranch aria-hidden="true" size={30} /><h2>{text.signInTitle}</h2><p>{text.signInDetail}</p><a className="primary-action" href={`/api/auth/github?return=${encodeURIComponent(returnPath)}`}><GitBranch aria-hidden="true" size={16} />{text.signIn}</a></section>}
    {valid && (sessionStatus === "loading" || flowState.status === "loading" || (sessionStatus === "ready" && session?.authenticated && flowState.status === "idle")) && <div className="product-load-state" role="status"><span><LoaderCircle aria-hidden="true" className="spin" size={16} />{text.loading}</span></div>}
    {valid && sessionStatus === "ready" && session?.authenticated && flowState.status === "error" && <div className="product-error" role="alert"><span>{flowState.message}</span><button type="button" onClick={() => void load()}>{text.retry}</button></div>}
    {valid && sessionStatus === "ready" && session?.authenticated && flowState.status === "ready" && <section className="cli-auth-card">
      {flowState.flow.state === "pending" && <>
        <div className="cli-auth-device"><MonitorSmartphone aria-hidden="true" size={24} /><div><span>{text.device}</span><strong>{flowState.flow.deviceName}</strong></div></div>
        <dl><div><dt>{text.account}</dt><dd>@{session.user?.login}</dd></div></dl>
        <p><ShieldCheck aria-hidden="true" size={17} />{text.access}</p>
        <button className="primary-action" type="button" disabled={approving} onClick={() => void approve()}><ShieldCheck aria-hidden="true" size={16} />{approving ? text.approving : text.approve}</button>
      </>}
      {flowState.flow.state === "approved" && <div className="cli-auth-result"><CheckCircle2 aria-hidden="true" size={30} /><h2>{flowState.flow.approvedByCurrentUser ? text.approved : text.different}</h2><p>{flowState.flow.approvedByCurrentUser ? text.approvedDetail : text.different}</p></div>}
      {flowState.flow.state === "complete" && <div className="cli-auth-result"><CheckCircle2 aria-hidden="true" size={30} /><h2>{text.complete}</h2><p>{text.completeDetail}</p></div>}
      {flowState.flow.state === "expired" && <div className="cli-auth-result is-expired"><MonitorSmartphone aria-hidden="true" size={30} /><h2>{text.expired}</h2><p>{text.expiredDetail}</p></div>}
    </section>}
  </main>;
}
