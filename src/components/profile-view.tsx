"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { forgeJson } from "./online-api";

interface PublicProfile {
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly login: string;
  readonly avatarUrl: string;
  readonly verifiedSolvedCount: number;
  readonly verifiedSolves: readonly {
    readonly managedProblemVersionId: string;
    readonly problemSlug: string;
    readonly title: Record<string, string>;
    readonly score: number;
    readonly solvedAt: string;
  }[];
}

export function ProfileView({ login }: { readonly login: string }) {
  const [profile, setProfile] = useState<PublicProfile>();
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => void forgeJson<{ profile: PublicProfile }>(`/api/profiles/${encodeURIComponent(login)}`)
      .then((result) => setProfile(result.profile))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))), 0);
    return () => window.clearTimeout(timer);
  }, [login]);
  return <main className="product-page profile-shell">
    <header className="product-page-header"><span className="product-eyebrow">Learner profile</span><h1>{profile?.displayName ?? login}</h1></header>
    {error && <section className="product-error">{error}</section>}
    {!profile && !error && <section className="product-empty large">Loading profile…</section>}
    {profile && <>
      <section className="public-profile-card"><Image src={profile.avatarUrl} alt="" width={88} height={88} unoptimized /><div><h2>{profile.displayName}</h2><p>@{profile.login} · {profile.verifiedSolvedCount} verified solved</p>{profile.bio && <p>{profile.bio}</p>}{profile.websiteUrl && <a href={profile.websiteUrl} rel="noreferrer">{profile.websiteUrl}</a>}</div></section>
      <section className="organizer-product-section"><h2>Verified solves</h2><div className="profile-solve-list">{profile.verifiedSolves.map((solve) => <Link href={`/problems/${encodeURIComponent(solve.managedProblemVersionId)}`} key={solve.managedProblemVersionId}><div><strong>{solve.title["zh-TW"] ?? solve.title.en ?? solve.problemSlug}</strong><span>{new Date(solve.solvedAt).toLocaleDateString()}</span></div><b>{solve.score}</b></Link>)}</div>{profile.verifiedSolves.length === 0 && <p className="product-empty">No verified solves yet.</p>}</section>
    </>}
  </main>;
}
