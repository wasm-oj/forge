"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { RemoteStateView, type RemoteState } from "../../../components/ui/remote-state";
import { wasmOjJson } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";

interface PublicProfile {
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly login: string;
  readonly avatarUrl: string;
  readonly verifiedSolvedCount: number;
  readonly verifiedSolves: readonly {
    readonly problemId: string;
    readonly problemSlug: string;
    readonly title: Record<string, string>;
    readonly score: number;
    readonly solvedAt: string;
  }[];
}

export function ProfileView({ login }: { readonly login: string }) {
  const { locale } = useProduct();
  const [state, setState] = useState<RemoteState<PublicProfile>>({ status: "loading" });
  const profile = state.status === "ready" ? state.data : undefined;
  usePageTitle(profile?.displayName ?? login);
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const result = await wasmOjJson<{ profile: PublicProfile }>(`/api/profiles/${encodeURIComponent(login)}`);
      setState({ status: "ready", data: result.profile });
    } catch (reason) {
      setState({ status: "error", message: reason instanceof Error ? reason.message : String(reason), retry: () => void load() });
    }
  }, [login]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const text = locale === "zh-TW" ? { eyebrow: "學習者個人檔案", loading: "正在載入個人檔案…", retry: "重試", verified: "題正式解題", solves: "正式解題紀錄", empty: "還沒有正式解題紀錄。" } : { eyebrow: "Learner profile", loading: "Loading profile…", retry: "Retry", verified: "verified solved", solves: "Verified solves", empty: "No verified solves yet." };
  return <main className="product-page profile-shell" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow">{text.eyebrow}</span><h1>{profile?.displayName ?? login}</h1></header>
    <RemoteStateView state={state} loadingLabel={text.loading} retryLabel={text.retry} empty={null} isEmpty={() => false}>{(current) => <>
      <section className="public-profile-card"><Image src={current.avatarUrl} alt="" width={88} height={88} unoptimized /><div><h2>{current.displayName}</h2><p>@{current.login} · {current.verifiedSolvedCount} {text.verified}</p>{current.bio && <p>{current.bio}</p>}{current.websiteUrl && <a href={current.websiteUrl} rel="noopener noreferrer">{current.websiteUrl}</a>}</div></section>
      <section className="organizer-product-section"><h2>{text.solves}</h2><div className="profile-solve-list">{current.verifiedSolves.map((solve) => <Link href={`/problems/${encodeURIComponent(solve.problemId)}`} key={solve.problemId}><div><strong>{solve.title[locale] ?? solve.title.en ?? solve.title["zh-TW"] ?? solve.problemSlug}</strong><span>{new Date(solve.solvedAt).toLocaleDateString(locale)}</span></div><b>{solve.score}</b></Link>)}</div>{current.verifiedSolves.length === 0 && <p className="product-empty">{text.empty}</p>}</section>
    </>}</RemoteStateView>
  </main>;
}
