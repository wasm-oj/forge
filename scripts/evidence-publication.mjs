import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Stage and verify every output before replacing any destination. If a rename
 * fails, restore every already-published destination to its original bytes.
 */
export async function publishEvidenceFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Evidence publication requires at least one output.");
  }
  const nonce = `${process.pid}-${randomUUID()}`;
  const publications = entries.map((entry) => ({
    path: path.resolve(entry.path),
    bytes: Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes),
  }));
  if (new Set(publications.map((entry) => entry.path)).size !== publications.length) {
    throw new Error("Evidence publication contains duplicate output paths.");
  }

  const states = [];
  try {
    for (const publication of publications) {
      await mkdir(path.dirname(publication.path), { recursive: true });
      const original = await readOptional(publication.path);
      const stagedPath = `${publication.path}.forge-stage-${nonce}`;
      await writeFile(stagedPath, publication.bytes, { flag: "wx" });
      const staged = await readFile(stagedPath);
      if (!staged.equals(publication.bytes)) {
        throw new Error(`Staged evidence verification failed for '${publication.path}'.`);
      }
      states.push({ ...publication, original, stagedPath, published: false });
    }

    for (const state of states) {
      await rename(state.stagedPath, state.path);
      state.published = true;
    }
  } catch (publicationError) {
    const rollbackErrors = [];
    for (const state of [...states].reverse()) {
      if (!state.published) continue;
      try {
        if (state.original === undefined) {
          await rm(state.path, { force: true });
        } else {
          const rollbackPath = `${state.path}.forge-rollback-${nonce}`;
          try {
            await writeFile(rollbackPath, state.original, { flag: "wx" });
            await rename(rollbackPath, state.path);
          } finally {
            await rm(rollbackPath, { force: true });
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [publicationError, ...rollbackErrors],
        "Evidence publication failed and could not restore every previous output.",
      );
    }
    throw publicationError;
  } finally {
    await Promise.all(states.map((state) => rm(state.stagedPath, { force: true })));
  }
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
