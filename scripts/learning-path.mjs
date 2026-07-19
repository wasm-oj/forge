export const LEARNING_PATH_SCHEMA = "wasm-oj-learning-path-v1";
export const LEARNING_PATH_LOCALES = Object.freeze(["zh-TW", "en"]);

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(message);
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unexpected keys: ${actual.join(", ")}`);
  }
}

function assertLocalizedText(value, label) {
  const record = assertRecord(value, label);
  assertExactKeys(record, LEARNING_PATH_LOCALES, label);
  for (const locale of LEARNING_PATH_LOCALES) {
    if (typeof record[locale] !== "string" || !record[locale] || record[locale] !== record[locale].trim()) {
      fail(`${label}[${locale}] must be a non-empty trimmed string`);
    }
  }
  return record;
}

export function applyLearningPath(value, problems) {
  const document = assertRecord(value, "learning-path.json");
  assertExactKeys(document, ["schema", "localization", "tracks"], "learning-path.json");
  if (document.schema !== LEARNING_PATH_SCHEMA) fail("learning-path.json uses an unsupported schema");
  if (JSON.stringify(document.localization) !== JSON.stringify({
    defaultLocale: "zh-TW",
    supportedLocales: LEARNING_PATH_LOCALES,
  })) {
    fail("learning-path.json uses an unsupported localization contract");
  }
  if (!Array.isArray(document.tracks) || document.tracks.length === 0) {
    fail("learning-path.json must contain at least one track");
  }

  const problemById = new Map(problems.map((problem) => [problem.id, problem]));
  if (problemById.size !== problems.length) fail("problem inventory contains duplicate IDs");
  const trackIds = new Set();
  const seenProblems = new Set();
  const ordered = [];
  for (const [trackIndex, trackValue] of document.tracks.entries()) {
    const label = `learning-path.json track ${trackIndex + 1}`;
    const track = assertRecord(trackValue, label);
    assertExactKeys(track, ["id", "title", "problems"], label);
    if (typeof track.id !== "string" || !ID_PATTERN.test(track.id) || trackIds.has(track.id)) {
      fail(`${label} has an invalid or duplicate ID`);
    }
    trackIds.add(track.id);
    const title = assertLocalizedText(track.title, `${label} title`);
    if (!Array.isArray(track.problems) || track.problems.length === 0) {
      fail(`${label} must contain at least one problem`);
    }
    for (const problemId of track.problems) {
      if (typeof problemId !== "string" || !ID_PATTERN.test(problemId)) {
        fail(`${label} contains an invalid problem ID`);
      }
      const problem = problemById.get(problemId);
      if (!problem) fail(`${label} references unknown problem '${problemId}'`);
      if (seenProblems.has(problemId)) fail(`learning-path.json repeats problem '${problemId}'`);
      seenProblems.add(problemId);
      ordered.push({ ...problem, number: ordered.length + 1, trackId: track.id, track: title });
    }
  }
  if (seenProblems.size !== problems.length) {
    const missing = problems.filter((problem) => !seenProblems.has(problem.id)).map((problem) => problem.id);
    fail(`learning-path.json omits problems: ${missing.join(", ")}`);
  }
  return ordered;
}
