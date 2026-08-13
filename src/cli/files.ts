import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError, usageError } from "./errors";
import { anchoredPathHasNoSymlink } from "../path-safety";

export async function readProtectedTextFile(cwd: string, value: string | undefined, option: string, maximumBytes = 1024): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const file = path.resolve(cwd, value);
  if (!await anchoredPathHasNoSymlink(file)) throw usageError(`${option} must name a real, non-symlink file.`);
  let metadata;
  try { metadata = await lstat(file); }
  catch (error) { throw new CliError(`${option} could not be read.`, { exitCode: 7, code: "protected-input-invalid", cause: error }); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) throw usageError(`${option} must name a real file containing at most ${maximumBytes} bytes.`);
  const bytes = new Uint8Array(await readFile(file));
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new CliError(`${option} is not valid UTF-8.`, { exitCode: 7, code: "protected-input-invalid", cause: error }); }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (!text || /[\r\n\0]/u.test(text)) throw usageError(`${option} must contain exactly one non-empty line.`);
  return text;
}

export async function atomicWriteFile(file: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function boundedRegularFileBytes(file: string, maximumBytes: number, expectedBytes?: number): Promise<Uint8Array> {
  if (!await anchoredPathHasNoSymlink(file)) throw new Error(`File '${file}' traverses a symbolic link.`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes || (expectedBytes !== undefined && metadata.size !== expectedBytes)) {
      throw new Error(`File '${file}' is outside its declared byte limit.`);
    }
    return new Uint8Array(await handle.readFile());
  } finally { await handle.close(); }
}
