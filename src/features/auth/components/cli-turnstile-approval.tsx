"use client";

import { CheckCircle2, GitBranch, LoaderCircle, Send, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { requestWasmOjTurnstileToken } from "../../../turnstile/client";
import { wasmOjCsrfToken, wasmOjJson } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";

const REQUEST_KEY = /^[0-9a-f]{64}$/;

interface ApprovalResponse {
  readonly requestKey: string;
  readonly state: "approved";
  readonly expiresAt: string;
}

const TEXT = {
  en: {
    title: "Verify Official Submit", eyebrow: "CLI Official Submit", intro: "Complete the browser check for the exact submission waiting in your terminal.",
    signInTitle: "Sign in to continue", signInDetail: "Use the same WASM-OJ account that is signed in to woj CLI.", signIn: "Sign in with GitHub",
    invalid: "This Official Submit verification link is invalid.", account: "Submission account", detail: "The verification creates a short allowance for this exact submission. The Turnstile token stays in this browser and is never sent to the CLI.",
    verify: "Verify Official Submit", verifying: "Opening verification…", approved: "Submission verified", approvedDetail: "Return to the terminal. woj will retry the same Official Submit automatically.",
  },
  "zh-TW": {
    title: "驗證正式提交", eyebrow: "CLI 正式提交", intro: "請在瀏覽器完成檢查，對應終端機裡正在等待的那一次提交。",
    signInTitle: "登入後繼續", signInDetail: "請使用與 woj CLI 相同的 WASM-OJ 帳號。", signIn: "使用 GitHub 登入",
    invalid: "這個正式提交驗證連結無效。", account: "提交帳號", detail: "驗證只會為這一筆提交建立短期許可；Turnstile 權杖會留在瀏覽器，不會傳給 CLI。",
    verify: "驗證正式提交", verifying: "正在開啟驗證…", approved: "提交已驗證", approvedDetail: "請回到終端機；woj 會自動重試同一筆正式提交。",
  },
} as const;

export function CliTurnstileApproval({ requestKey }: { readonly requestKey: string }) {
  const { locale, session, sessionStatus } = useProduct();
  const text = TEXT[locale];
  const [state, setState] = useState<"idle" | "verifying" | "approved">("idle");
  const [error, setError] = useState("");
  usePageTitle(text.title);

  const approve = useCallback(async () => {
    if (!REQUEST_KEY.test(requestKey)) return;
    setState("verifying");
    setError("");
    try {
      const csrf = wasmOjCsrfToken();
      if (!csrf) throw new Error("Sign in again: the CSRF token is missing.");
      const token = await requestWasmOjTurnstileToken("official-submit");
      await wasmOjJson<ApprovalResponse>("/api/auth/cli/turnstile/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-wasm-oj-csrf": csrf,
          "x-wasm-oj-turnstile-token": token,
        },
        body: JSON.stringify({ requestKey }),
      });
      setState("approved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("idle");
    }
  }, [requestKey]);

  const valid = REQUEST_KEY.test(requestKey);
  const returnPath = `/auth/cli/turnstile?requestKey=${encodeURIComponent(requestKey)}`;
  return <main className="product-page narrow-page cli-auth-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><Send aria-hidden="true" size={14} /> {text.eyebrow}</span><h1>{text.title}</h1><p>{text.intro}</p></header>
    {!valid && <div className="product-error" role="alert"><span>{text.invalid}</span></div>}
    {valid && sessionStatus === "error" && <div className="product-error" role="alert"><span>{text.invalid}</span></div>}
    {valid && sessionStatus === "loading" && <div className="product-load-state" role="status"><span><LoaderCircle aria-hidden="true" className="spin" size={16} />{text.verifying}</span></div>}
    {valid && sessionStatus === "ready" && !session?.authenticated && <section className="sign-in-empty"><GitBranch aria-hidden="true" size={30} /><h2>{text.signInTitle}</h2><p>{text.signInDetail}</p><a className="primary-action" href={`/api/auth/github?return=${encodeURIComponent(returnPath)}`}><GitBranch aria-hidden="true" size={16} />{text.signIn}</a></section>}
    {valid && sessionStatus === "ready" && session?.authenticated && <section className="cli-auth-card">
      {state !== "approved" && <>
        <dl><div><dt>{text.account}</dt><dd>@{session.user?.login}</dd></div></dl>
        <p><ShieldCheck aria-hidden="true" size={17} />{text.detail}</p>
        {error && <div className="product-error" role="alert"><span>{error}</span></div>}
        <button className="primary-action" type="button" disabled={state === "verifying"} onClick={() => void approve()}><ShieldCheck aria-hidden="true" size={16} />{state === "verifying" ? text.verifying : text.verify}</button>
      </>}
      {state === "approved" && <div className="cli-auth-result"><CheckCircle2 aria-hidden="true" size={30} /><h2>{text.approved}</h2><p>{text.approvedDetail}</p></div>}
    </section>}
  </main>;
}
