"use client";

import { ChevronRight, Clock3, GitBranch, ListChecks, Trophy, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useProduct } from "./app-shell";
import { copy, formatDate, localized, type ContestSummary, type Profile, type SubmissionSummary } from "./education-model";
import { forgeJson, forgeMutation } from "./online-api";

export function ContestList() {
  const { locale } = useProduct();
  const [contests, setContests] = useState<readonly ContestSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void forgeJson<{ contests: readonly ContestSummary[] }>("/api/contests?limit=100").then((value) => setContests(value.contests)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);
  return <main className="product-page" id="main-content"><header className="product-page-header"><span className="product-eyebrow"><Trophy size={14} /> Compete</span><h1>{copy[locale].contests}</h1><p>{copy[locale].upcoming}</p></header>{error && <div className="product-error">{error}</div>}<div className="contest-catalog">{(["running", "upcoming", "ended"] as const).map((phase) => <section key={phase}><h2>{phase}</h2><div className="contest-card-grid">{contests.filter((contest) => contest.phase === phase).map((contest) => <Link className="contest-card" key={contest.id} href={`/contests/${contest.id}`}><div><span className={`contest-phase ${phase}`}>{phase}</span><span>{contest.accessMode}</span></div><h3>{contest.title}</h3><p>{contest.description}</p><footer><span><Clock3 size={14} />{formatDate(contest.startsAt, locale)}</span><ChevronRight size={16} /></footer></Link>)}</div>{contests.filter((contest) => contest.phase === phase).length === 0 && <p className="product-empty">No {phase} contests.</p>}</section>)}</div></main>;
}

function SignInEmpty({ returnPath }: { readonly returnPath: string }) {
  const { locale } = useProduct();
  return <div className="sign-in-empty"><UserRound size={30} /><h2>{copy[locale].signIn}</h2><p>{copy[locale].anonymous}</p><a className="primary-action" href={`/api/auth/github?return=${encodeURIComponent(returnPath)}`}><GitBranch size={16} />{copy[locale].signIn}</a></div>;
}

export function SubmissionList() {
  const { locale, session } = useProduct();
  const text = copy[locale];
  const [submissions, setSubmissions] = useState<readonly SubmissionSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { if (session?.authenticated) void forgeJson<{ submissions: readonly SubmissionSummary[] }>("/api/submissions?limit=100").then((value) => setSubmissions(value.submissions)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [session?.authenticated]);
  return <div className="product-page"><header className="product-page-header"><span className="product-eyebrow"><ListChecks size={14} /> History</span><h1>{text.submissions}</h1><p>{text.submissionsIntro}</p></header>{!session?.authenticated ? <SignInEmpty returnPath="/submissions" /> : <div className="submission-list">{submissions.map((submission) => <Link href={`/submissions/${submission.id}`} className="submission-row" key={submission.id}><span className={`submission-verdict state-${submission.state}`}>{submission.state}</span><div><strong>{localized(submission.problem?.title, locale, submission.problem?.slug)}</strong><small>{submission.contest?.title ?? "Official practice"} · {submission.language}</small></div><span>{submission.score ?? "—"}</span><time>{formatDate(submission.createdAt, locale)}</time><ChevronRight size={16} /></Link>)}{submissions.length === 0 && <div className="product-empty large">{text.noSubmissions}</div>}</div>}{error && <div className="product-error">{error}</div>}</div>;
}

export function SubmissionDetail({ submissionId }: { readonly submissionId: string }) {
  const { locale } = useProduct();
  const [submission, setSubmission] = useState<SubmissionSummary>();
  const [error, setError] = useState("");
  useEffect(() => { void forgeJson<{ submission: SubmissionSummary }>(`/api/submissions/${encodeURIComponent(submissionId)}`).then((value) => setSubmission(value.submission)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [submissionId]);
  if (error) return <div className="product-page"><div className="product-error">{error}</div></div>;
  if (!submission) return <div className="product-page"><div className="product-empty large">Loading submission…</div></div>;
  return <div className="product-page"><header className="product-page-header"><Link className="product-back" href="/submissions">← {copy[locale].submissions}</Link><h1>{localized(submission.problem?.title, locale, submission.problem?.slug)}</h1><p>{submission.contest?.title ?? "Official practice"} · {formatDate(submission.createdAt, locale)}</p></header><div className="submission-detail-grid"><article><span>Verdict</span><strong className={`state-${submission.state}`}>{submission.state}</strong></article><article><span>Score</span><strong>{submission.score ?? "—"}</strong></article><article><span>Language</span><strong>{submission.language}</strong></article><article><span>Passed cases</span><strong>{submission.fullyPassedCases ?? "—"}</strong></article><article><span>Peak memory</span><strong>{submission.peakMemoryBytes === null ? "—" : `${(submission.peakMemoryBytes / 1_048_576).toFixed(1)} MiB`}</strong></article><article><span>Visibility</span><strong>{submission.visibility}</strong></article></div><div className="detail-actions"><Link className="primary-action" href={submission.contest ? `/contests/${submission.contest.id}/problems/${submission.managedProblemVersionId}` : `/problems/${submission.managedProblemVersionId}`}>Open problem</Link>{submission.visibility === "public" && <a className="secondary-action" href={`/api/submissions/${submission.id}/source`}>View source</a>}</div></div>;
}

export function ProfileSettings() {
  const { locale, session } = useProduct();
  const text = copy[locale];
  const [profile, setProfile] = useState<Profile>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (session?.authenticated) void forgeJson<{ profile: Profile }>("/api/profile").then((value) => setProfile(value.profile)).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason))); }, [session?.authenticated]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setBusy(true); setMessage("");
    try { await forgeMutation("/api/profile", { displayName: profile.displayName, bio: profile.bio, websiteUrl: profile.websiteUrl ?? undefined, visibility: profile.visibility }, "PATCH"); setMessage(text.saved); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  /* The GitHub avatar URL is user-owned and intentionally loaded directly. */
  // eslint-disable-next-line @next/next/no-img-element
  return <div className="product-page narrow-page"><header className="product-page-header"><span className="product-eyebrow"><UserRound size={14} /> Account</span><h1>{text.profile}</h1><p>{text.profileIntro}</p></header>{!session?.authenticated ? <SignInEmpty returnPath="/settings/profile" /> : profile && <form className="profile-form" onSubmit={(event) => void save(event)}><div className="profile-identity"><img src={profile.avatarUrl} alt="" /><div><strong>{profile.displayName}</strong><span>@{profile.login} · {profile.verifiedSolvedCount} solved</span></div></div><label>Display name<input value={profile.displayName} maxLength={80} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} /></label><label>Bio<textarea value={profile.bio} maxLength={2000} onChange={(event) => setProfile({ ...profile, bio: event.target.value })} /></label><label>Website<input type="url" value={profile.websiteUrl ?? ""} onChange={(event) => setProfile({ ...profile, websiteUrl: event.target.value || null })} /></label><label>Profile visibility<select value={profile.visibility} onChange={(event) => setProfile({ ...profile, visibility: event.target.value as Profile["visibility"] })}><option value="public">Public</option><option value="private">Private</option></select></label><button className="primary-action" disabled={busy}>{text.save}</button>{message && <output role="status">{message}</output>}</form>}</div>;
}
