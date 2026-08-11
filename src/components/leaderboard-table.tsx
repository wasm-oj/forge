"use client";

import Link from "next/link";
import Image from "next/image";
import { languageLabel } from "../core/toolchains";

export interface PublicLeaderboardEntry {
  readonly rank: number;
  readonly participant: {
    readonly id: string;
    readonly kind: "profile" | "anonymous" | "deleted";
    readonly label: string;
    readonly login?: string;
    readonly avatarUrl?: string;
  };
  readonly language?: string;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
  readonly attemptedProblems?: number;
  readonly problemResults?: readonly {
    readonly problemVersionId: string;
    readonly score: number;
    readonly fullyPassedCases: number;
  }[];
  readonly submissionId?: string;
}

function Participant({ entry }: { readonly entry: PublicLeaderboardEntry }) {
  const content = <>{entry.participant.avatarUrl && <Image src={entry.participant.avatarUrl} alt="" width={24} height={24} unoptimized />}<span>{entry.participant.label}</span></>;
  return entry.participant.kind === "profile" && entry.participant.login
    ? <Link className="leaderboard-participant" href={`/profiles/${encodeURIComponent(entry.participant.login)}`}>{content}</Link>
    : <span className="leaderboard-participant">{content}</span>;
}

export function LeaderboardTable({ entries, showProblems = false, showLanguage = false, problemColumns = [] }: { readonly entries: readonly PublicLeaderboardEntry[]; readonly showProblems?: boolean; readonly showLanguage?: boolean; readonly problemColumns?: readonly { readonly id: string; readonly label: string }[] }) {
  return <div className="online-table-wrap"><table className="online-table leaderboard-table"><thead><tr><th>#</th><th>Participant</th>{showLanguage && <th>Language</th>}<th>Score</th><th>Passed</th>{showProblems && problemColumns.length === 0 && <th>Problems</th>}{showProblems && problemColumns.map((problem) => <th key={problem.id} title={`Problem ${problem.label}`}>P{problem.label}</th>)}<th>Cost</th><th>Peak memory</th><th>Achieved</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.participant.id}>
    <td>{entry.rank}</td><td><Participant entry={entry} /></td>{showLanguage && <td>{entry.language ? languageLabel(entry.language) : "—"}</td>}<td>{entry.score}</td><td>{entry.fullyPassedCases}</td>{showProblems && problemColumns.length === 0 && <td>{entry.attemptedProblems ?? 0}</td>}{showProblems && problemColumns.map((problem) => { const result = entry.problemResults?.find((candidate) => candidate.problemVersionId === problem.id); return <td key={problem.id} title={result ? `${result.fullyPassedCases} passed cases` : "Not attempted"}>{result?.score ?? "—"}</td>; })}<td>{entry.deterministicCost.toLocaleString()}</td><td>{(entry.peakMemoryBytes / 1_048_576).toFixed(1)} MiB</td><td>{new Date(entry.achievedAt).toLocaleString()}</td>
  </tr>)}</tbody></table>{showProblems && problemColumns.length > 0 && <div className="leaderboard-problem-breakdowns">{entries.map((entry) => <details key={entry.participant.id}><summary>#{entry.rank} · {entry.participant.label} · {entry.score} points</summary><dl>{problemColumns.map((problem) => { const result = entry.problemResults?.find((candidate) => candidate.problemVersionId === problem.id); return <div key={problem.id}><dt>Problem {problem.label}</dt><dd>{result ? `${result.score} points · ${result.fullyPassedCases} passed` : "Not attempted"}</dd></div>; })}</dl></details>)}</div>}</div>;
}
