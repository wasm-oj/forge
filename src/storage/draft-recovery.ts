import {
  canonicalProjectFiles,
  PROJECT_SOURCE_LIMITS,
  assertSafeRelativePath,
} from "../core/project-files";
import { assertValidProject } from "../core/project-validation";
import type { Project, ProjectFile } from "../core/types";

export const DRAFT_SOURCE_EXPORT_SCHEMA = "wasm-oj-platform/source-draft/v1" as const;

/**
 * JSON escaping can expand a valid 16 MiB source tree. Bound the transport
 * independently while the decoded files remain subject to PROJECT_SOURCE_LIMITS.
 */
export const DRAFT_SOURCE_EXPORT_MAX_BYTES = 128 * 1024 * 1024;

const ENVELOPE_KEYS = Object.freeze(["schema", "entry", "activeFile", "files"] as const);
const FILE_KEYS = Object.freeze(["path", "language", "content"] as const);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface DraftSourceExport {
  readonly schema: typeof DRAFT_SOURCE_EXPORT_SCHEMA;
  readonly entry: string;
  readonly activeFile: string;
  readonly files: readonly ProjectFile[];
}

/**
 * Produces a manual-recovery artifact containing source bytes and source-file
 * selection only. Project identity, execution input, environment, dependency
 * metadata, results, and credentials are deliberately excluded.
 */
export function encodeDraftSourceExport(project: Project): string {
  assertValidProject(project);
  const envelope: DraftSourceExport = {
    schema: DRAFT_SOURCE_EXPORT_SCHEMA,
    entry: project.config.entry,
    activeFile: project.activeFile,
    files: canonicalProjectFiles(project.files),
  };
  const encoded = `${JSON.stringify(envelope)}\n`;
  assertTransportSize(UTF8_ENCODER.encode(encoded).byteLength);
  return encoded;
}

/** Strictly decodes an untrusted recovery artifact without shape recovery. */
export function decodeDraftSourceExport(input: string | Uint8Array): DraftSourceExport {
  const text = decodeBoundedUtf8(input);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Draft source export must be valid UTF-8 JSON.", { cause: error });
  }

  const envelope = exactRecord(decoded, "Draft source export", ENVELOPE_KEYS);
  if (envelope.schema !== DRAFT_SOURCE_EXPORT_SCHEMA) {
    throw new Error(`Draft source export schema must be '${DRAFT_SOURCE_EXPORT_SCHEMA}'.`);
  }
  assertSafeRelativePath(envelope.entry, "Draft source entry");
  assertSafeRelativePath(envelope.activeFile, "Draft active file");
  if (!Array.isArray(envelope.files) || envelope.files.length === 0) {
    throw new Error("Draft source export must contain at least one source file.");
  }
  if (envelope.files.length > PROJECT_SOURCE_LIMITS.files) {
    throw new Error(`A draft source export cannot contain more than ${PROJECT_SOURCE_LIMITS.files} files.`);
  }

  const candidateFiles = envelope.files.map((candidate, index) => {
    const file = exactRecord(candidate, `Draft source file ${index}`, FILE_KEYS);
    return {
      path: file.path,
      language: file.language,
      content: file.content,
    } as ProjectFile;
  });
  const files = canonicalProjectFiles(candidateFiles);
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has(envelope.entry)) {
    throw new Error(`Draft source entry '${envelope.entry}' is not present in the exported files.`);
  }
  if (!paths.has(envelope.activeFile)) {
    throw new Error(`Draft active file '${envelope.activeFile}' is not present in the exported files.`);
  }

  return Object.freeze({
    schema: DRAFT_SOURCE_EXPORT_SCHEMA,
    entry: envelope.entry,
    activeFile: envelope.activeFile,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

/** Applies validated source-only data to an existing workspace. */
export function restoreProjectSources(
  current: Project,
  input: string | Uint8Array,
  updatedAt = Date.now(),
): Project {
  assertValidProject(current);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) {
    throw new Error("Restored draft updatedAt must be a non-negative finite number.");
  }
  const recovered = decodeDraftSourceExport(input);
  const entry = recovered.files.find((file) => file.path === recovered.entry);
  if (!entry) throw new Error("Validated draft source entry is unexpectedly absent.");
  if (entry.language !== current.config.language) {
    throw new Error(
      `Draft entry language '${entry.language}' does not match this workspace language '${current.config.language}'.`,
    );
  }
  const restored: Project = {
    ...structuredClone(current),
    files: recovered.files.map((file) => ({ ...file })),
    activeFile: recovered.activeFile,
    config: { ...structuredClone(current.config), entry: recovered.entry },
    updatedAt,
  };
  assertValidProject(restored);
  return restored;
}

function decodeBoundedUtf8(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (input.length > DRAFT_SOURCE_EXPORT_MAX_BYTES) {
      assertTransportSize(input.length);
    }
    assertTransportSize(UTF8_ENCODER.encode(input).byteLength);
    return input;
  }
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("Draft source export must be a string or Uint8Array.");
  }
  assertTransportSize(input.byteLength);
  try {
    return UTF8_DECODER.decode(input);
  } catch (error) {
    throw new Error("Draft source export must be valid UTF-8 JSON.", { cause: error });
  }
}

function assertTransportSize(byteLength: number): void {
  if (byteLength > DRAFT_SOURCE_EXPORT_MAX_BYTES) {
    throw new Error(`Draft source export exceeds the ${DRAFT_SOURCE_EXPORT_MAX_BYTES} byte limit.`);
  }
}

function exactRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly: ${expectedKeys.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}
