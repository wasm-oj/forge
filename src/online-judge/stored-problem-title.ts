import type { LocalizedText } from "../judge/problem-model";

const LOCALES = ["zh-TW", "en"] as const;

export function parseStoredProblemTitle(value: unknown): LocalizedText {
  if (typeof value !== "string" || value.length < 1 || value.length > 16 * 1024) throw new TypeError("Stored problem title JSON is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Stored problem title JSON is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Stored problem title JSON is invalid.");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== LOCALES.length || LOCALES.some((locale) => !Object.hasOwn(record, locale))) {
    throw new TypeError("Stored problem title JSON is invalid.");
  }
  for (const locale of LOCALES) {
    const text = record[locale];
    if (typeof text !== "string" || text.length < 1 || text.length > 4_096 || text !== text.trim()) {
      throw new TypeError("Stored problem title JSON is invalid.");
    }
  }
  return { "zh-TW": record["zh-TW"] as string, en: record.en as string };
}
