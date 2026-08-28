"use client";

import Link from "next/link";
import Image from "next/image";
import { languageLabel } from "../../../core/toolchains";

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
    readonly problemId: string;
    readonly score: number;
    readonly fullyPassedCases: number;
  }[];
  readonly submissionId?: string;
  readonly solved?: number;
  readonly penaltyMinutes?: number;
  readonly furthestCheckpoint?: number;
  readonly achievedAtLogicalSeconds?: number;
  readonly eliminated?: boolean;
  readonly provisional?: boolean;
}

type LeaderboardScoringKind = "score" | "icpc" | "progress";

function logicalTimeLabel(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function Participant({ entry, provisionalLabel, eliminatedLabel }: { readonly entry: PublicLeaderboardEntry; readonly provisionalLabel: string; readonly eliminatedLabel: string }) {
  const content = <>{entry.participant.avatarUrl && <Image src={entry.participant.avatarUrl} alt="" width={24} height={24} unoptimized />}<span>{entry.participant.label}</span></>;
  const identity = entry.participant.kind === "profile" && entry.participant.login
    ? <Link className="leaderboard-participant" href={`/profiles/${encodeURIComponent(entry.participant.login)}`}>{content}</Link>
    : <span className="leaderboard-participant">{content}</span>;
  return <div className="leaderboard-identity">{identity}{(entry.provisional || entry.eliminated) && <span className="leaderboard-statuses">{entry.provisional && <span className="leaderboard-status provisional">{provisionalLabel}</span>}{entry.eliminated && <span className="leaderboard-status eliminated">{eliminatedLabel}</span>}</span>}</div>;
}

export function LeaderboardTable({
  entries,
  showProblems = false,
  showLanguage = false,
  problemColumns = [],
  scoringKind = "score",
  checkpointCount = 0,
  locale,
}: {
  readonly entries: readonly PublicLeaderboardEntry[];
  readonly showProblems?: boolean;
  readonly showLanguage?: boolean;
  readonly problemColumns?: readonly { readonly id: string; readonly label: string }[];
  readonly scoringKind?: LeaderboardScoringKind;
  readonly checkpointCount?: number;
  readonly locale?: string;
}) {
  const zh = locale?.toLowerCase().startsWith("zh") ?? false;
  const labels = zh ? {
    caption: "競賽排行榜",
    participant: "參賽者",
    language: "語言",
    score: "分數",
    passed: "通過",
    solved: "解題",
    penalty: "罰時",
    progress: "進度",
    problems: "題目",
    cost: "成本",
    memory: "最高記憶體",
    logicalTime: "邏輯時間",
    achieved: "達成時間",
    provisional: "暫定",
    eliminated: "已淘汰",
    noResults: "目前還沒有排行結果。",
  } : {
    caption: "Contest leaderboard",
    participant: "Participant",
    language: "Language",
    score: "Score",
    passed: "Passed",
    solved: "Solved",
    penalty: "Penalty",
    progress: "Progress",
    problems: "Problems",
    cost: "Cost",
    memory: "Peak memory",
    logicalTime: "Logical time",
    achieved: "Achieved",
    provisional: "Provisional",
    eliminated: "Eliminated",
    noResults: "No standings yet.",
  };
  if (entries.length === 0) return <p className="product-empty">{labels.noResults}</p>;
  const formatNumber = (value: number) => value.toLocaleString(locale);
  const primaryColumns = scoringKind === "icpc"
    ? <><th>{labels.solved}</th><th>{labels.penalty}</th></>
    : scoringKind === "progress"
      ? <><th>{labels.progress}</th><th>{labels.solved}</th><th>{labels.score}</th></>
      : <><th>{labels.score}</th><th>{labels.passed}</th></>;
  return <div className="online-table-wrap"><table className="online-table leaderboard-table"><caption className="sr-only">{labels.caption}</caption><thead><tr><th>#</th><th>{labels.participant}</th>{showLanguage && <th>{labels.language}</th>}{primaryColumns}{showProblems && problemColumns.length === 0 && <th>{labels.problems}</th>}{showProblems && problemColumns.map((problem) => <th key={problem.id} title={`${zh ? "題目" : "Problem"} ${problem.label}`}>P{problem.label}</th>)}<th>{labels.cost}</th><th>{labels.memory}</th><th>{entries.some((entry) => entry.achievedAtLogicalSeconds !== undefined) ? labels.logicalTime : labels.achieved}</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.participant.id} className={entry.eliminated ? "leaderboard-row-eliminated" : undefined}>
    <td>{entry.rank}</td><td><Participant entry={entry} provisionalLabel={labels.provisional} eliminatedLabel={labels.eliminated} /></td>{showLanguage && <td>{entry.language ? languageLabel(entry.language) : "—"}</td>}{scoringKind === "icpc" ? <><td>{entry.solved ?? 0}</td><td>{formatNumber(entry.penaltyMinutes ?? 0)} min</td></> : scoringKind === "progress" ? <><td>{entry.furthestCheckpoint ?? 0}{checkpointCount > 0 ? ` / ${checkpointCount}` : ""}</td><td>{entry.solved ?? 0}</td><td>{formatNumber(entry.score)}</td></> : <><td>{formatNumber(entry.score)}</td><td>{formatNumber(entry.fullyPassedCases)}</td></>}{showProblems && problemColumns.length === 0 && <td>{entry.attemptedProblems ?? 0}</td>}{showProblems && problemColumns.map((problem) => { const result = entry.problemResults?.find((candidate) => candidate.problemId === problem.id); const title = result ? (scoringKind === "icpc" ? labels.solved : `${result.fullyPassedCases} ${zh ? "個測資通過" : "passed cases"}`) : (zh ? "尚未作答" : "Not attempted"); return <td key={problem.id} title={title}>{result ? (scoringKind === "icpc" ? labels.solved : result.score) : "—"}</td>; })}<td>{formatNumber(entry.deterministicCost)}</td><td>{(entry.peakMemoryBytes / 1_048_576).toFixed(1)} MiB</td><td className="leaderboard-time">{entry.achievedAtLogicalSeconds !== undefined ? logicalTimeLabel(entry.achievedAtLogicalSeconds) : new Date(entry.achievedAt).toLocaleString(locale)}</td>
  </tr>)}</tbody></table>{showProblems && problemColumns.length > 0 && <div className="leaderboard-problem-breakdowns">{entries.map((entry) => <details key={entry.participant.id}><summary>#{entry.rank} · {entry.participant.label} · {scoringKind === "icpc" ? `${entry.solved ?? 0} solved · ${entry.penaltyMinutes ?? 0} min` : scoringKind === "progress" ? `checkpoint ${entry.furthestCheckpoint ?? 0}${checkpointCount > 0 ? ` of ${checkpointCount}` : ""} · ${entry.score} points` : `${entry.score} points`}</summary><dl>{problemColumns.map((problem) => { const result = entry.problemResults?.find((candidate) => candidate.problemId === problem.id); return <div key={problem.id}><dt>Problem {problem.label}</dt><dd>{result ? (scoringKind === "icpc" ? "Solved" : `${result.score} points · ${result.fullyPassedCases} passed`) : "Not attempted"}</dd></div>; })}</dl></details>)}</div>}</div>;
}
