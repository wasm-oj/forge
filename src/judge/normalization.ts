export type OutputNormalization = "exact" | "lines" | "trimmed-lines";

export function normalizeOutput(value: string, mode: OutputNormalization): string {
  if (mode === "exact") return value;
  const lines = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.at(-1) === "") lines.pop();
  const normalized = lines.join("\n");
  return mode === "trimmed-lines" ? normalized.trim() : normalized;
}
