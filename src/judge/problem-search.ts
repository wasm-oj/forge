import type { JudgeProblemSummary } from "./problem-model";

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export function matchesProblemSearch(problem: JudgeProblemSummary, query: string): boolean {
  const terms = normalizeSearchText(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const number = String(problem.number);
  const searchable = normalizeSearchText([
    problem.id,
    problem.trackId,
    number,
    `#${number}`,
    String(problem.number).padStart(2, "0"),
    problem.title["zh-TW"],
    problem.title.en,
    problem.track["zh-TW"],
    problem.track.en,
    ...problem.tags,
  ].join("\n"));
  return terms.every((term) => searchable.includes(term));
}
