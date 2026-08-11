"use client";

import Link from "next/link";
import Image from "next/image";

export interface PublicLeaderboardEntry {
  readonly rank: number;
  readonly participant: {
    readonly id: string;
    readonly kind: "profile" | "anonymous" | "deleted";
    readonly label: string;
    readonly login?: string;
    readonly avatarUrl?: string;
  };
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
  readonly attemptedProblems?: number;
  readonly submissionId?: string;
}

function Participant({ entry }: { readonly entry: PublicLeaderboardEntry }) {
  const content = <>{entry.participant.avatarUrl && <Image src={entry.participant.avatarUrl} alt="" width={24} height={24} unoptimized />}<span>{entry.participant.label}</span></>;
  return entry.participant.kind === "profile" && entry.participant.login
    ? <Link className="leaderboard-participant" href={`/profiles/${encodeURIComponent(entry.participant.login)}`}>{content}</Link>
    : <span className="leaderboard-participant">{content}</span>;
}

export function LeaderboardTable({ entries, showProblems = false }: { readonly entries: readonly PublicLeaderboardEntry[]; readonly showProblems?: boolean }) {
  return <div className="online-table-wrap"><table className="online-table leaderboard-table"><thead><tr><th>#</th><th>Participant</th><th>Score</th><th>Passed</th>{showProblems && <th>Problems</th>}<th>Cost</th><th>Peak memory</th><th>Achieved</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.participant.id}>
    <td>{entry.rank}</td><td><Participant entry={entry} /></td><td>{entry.score}</td><td>{entry.fullyPassedCases}</td>{showProblems && <td>{entry.attemptedProblems ?? 0}</td>}<td>{entry.deterministicCost.toLocaleString()}</td><td>{(entry.peakMemoryBytes / 1_048_576).toFixed(1)} MiB</td><td>{new Date(entry.achievedAt).toLocaleString()}</td>
  </tr>)}</tbody></table></div>;
}
