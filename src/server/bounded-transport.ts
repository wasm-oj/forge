import { lstat, open } from "node:fs/promises";

/** Collects a child-process channel without permitting unbounded host memory growth. */
export class BoundedByteCollector {
  private readonly chunks: Buffer[] = [];
  private readonly label: string;
  private readonly maximumBytes: number;
  private readonly onLimitExceeded: (error: Error) => void;
  private totalBytes = 0;
  private limitError?: Error;

  constructor(
    label: string,
    maximumBytes: number,
    onLimitExceeded: (error: Error) => void,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new TypeError("A bounded transport limit must be a positive safe integer.");
    }
    this.label = label;
    this.maximumBytes = maximumBytes;
    this.onLimitExceeded = onLimitExceeded;
  }

  append(chunk: Uint8Array): void {
    if (this.limitError) return;
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maximumBytes) {
      this.limitError = new Error(`${this.label} exceeded the ${this.maximumBytes} byte transport boundary.`);
      this.chunks.length = 0;
      this.onLimitExceeded(this.limitError);
      return;
    }
    this.chunks.push(Buffer.from(chunk));
  }

  bytes(): Buffer {
    if (this.limitError) throw this.limitError;
    return Buffer.concat(this.chunks, this.totalBytes);
  }

  text(): string {
    return this.bytes().toString("utf8");
  }
}

/** Reads a private one-shot response through a stable descriptor and enforces a hard byte cap. */
export async function readBoundedRegularFile(filename: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("A bounded file limit must be a positive safe integer.");
  }
  const pathStatus = await lstat(filename);
  if (!pathStatus.isFile()) throw new Error(`Transport response '${filename}' must be a regular file.`);
  if (pathStatus.size > maximumBytes) {
    throw new Error(`Transport response '${filename}' exceeds the ${maximumBytes} byte boundary.`);
  }

  const handle = await open(filename, "r");
  try {
    const descriptorStatus = await handle.stat();
    if (
      !descriptorStatus.isFile()
      || descriptorStatus.dev !== pathStatus.dev
      || descriptorStatus.ino !== pathStatus.ino
    ) {
      throw new Error(`Transport response '${filename}' changed before it could be read.`);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - totalBytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        throw new Error(`Transport response '${filename}' exceeds the ${maximumBytes} byte boundary.`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}
