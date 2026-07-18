import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BoundedByteCollector, readBoundedRegularFile } from "./bounded-transport";

describe("bounded server transports", () => {
  it("fails closed and releases buffered chunks when a stream crosses its cap", () => {
    const onLimit = vi.fn();
    const collector = new BoundedByteCollector("test output", 4, onLimit);
    collector.append(Buffer.from("ab"));
    collector.append(Buffer.from("cde"));

    expect(onLimit).toHaveBeenCalledOnce();
    expect(() => collector.bytes()).toThrow("exceeded the 4 byte transport boundary");
  });

  it("reads only regular, stable files within the requested cap", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forge-bounded-transport-"));
    try {
      const response = path.join(directory, "response.bin");
      await writeFile(response, "12345");
      await expect(readBoundedRegularFile(response, 5)).resolves.toEqual(Buffer.from("12345"));
      await expect(readBoundedRegularFile(response, 4)).rejects.toThrow("exceeds the 4 byte boundary");

      const link = path.join(directory, "response-link.bin");
      await symlink(response, link);
      await expect(readBoundedRegularFile(link, 5)).rejects.toThrow("must be a regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
