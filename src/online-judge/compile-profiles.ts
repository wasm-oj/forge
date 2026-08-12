import { isBuiltinLanguage, type BuiltinLanguage } from "../core/types.ts";

export interface JudgeAllowedProfile {
  readonly target: "wasip1" | "wasix";
  readonly optimization: "debug" | "release";
}

export type JudgeAllowedProfiles = Readonly<Partial<Record<BuiltinLanguage, JudgeAllowedProfile>>>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function parseJudgeAllowedProfiles(value: unknown, label = "allowedProfiles"): JudgeAllowedProfiles {
  const profiles = record(value, label);
  const entries = Object.entries(profiles).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length < 1) throw new TypeError(`${label} must contain at least one compile profile.`);
  const result: Partial<Record<BuiltinLanguage, JudgeAllowedProfile>> = {};
  for (const [language, candidate] of entries) {
    if (!isBuiltinLanguage(language)) throw new TypeError(`${label} language '${language}' is unsupported.`);
    const profile = record(candidate, `${label}.${language}`);
    if (JSON.stringify(Object.keys(profile).sort()) !== JSON.stringify(["optimization", "target"])) {
      throw new TypeError(`${label}.${language} has an invalid shape.`);
    }
    if (profile.target !== "wasip1" && profile.target !== "wasix") throw new TypeError(`${label}.${language}.target is unsupported.`);
    if (profile.optimization !== "debug" && profile.optimization !== "release") throw new TypeError(`${label}.${language}.optimization is unsupported.`);
    result[language] = { target: profile.target, optimization: profile.optimization };
  }
  return result;
}
