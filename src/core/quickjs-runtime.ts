import { QUICKJS_BUFFER_DECLARATION } from "../runtime/quickjs/stdlib.generated.ts";

export const QUICKJS_STD_MODULE_DECLARATION = String.raw`
declare module "std" {
  const std: {
    err: { puts(value: string): void };
    in: { readAsString(): string };
    out: { puts(value: string): void };
  };
  export default std;
  export const err: typeof std.err;
  export const out: typeof std.out;
  const input: typeof std.in;
  export { input as in };
}
`;

export const QUICKJS_NODE_MODULE_DECLARATION = QUICKJS_BUFFER_DECLARATION + String.raw`
type BufferEncoding = "ascii" | "utf8" | "utf-8" | "utf16le" | "utf-16le" | "ucs2" | "ucs-2" | "base64" | "latin1" | "binary" | "hex";
type Buffer = import("buffer").Buffer;
declare const Buffer: typeof import("buffer").Buffer;
interface NodeReadable extends AsyncIterable<Buffer | string> {
  on(event: "data", callback: (chunk: Buffer | string) => void): this;
  on(event: "readable" | "end" | "close", callback: () => void): this;
  on(event: "error", callback: (error: Error) => void): this;
  setEncoding(encoding: BufferEncoding): this;
  read(size?: number): Buffer | string | null;
  resume(): this;
  pause(): this;
  pipe<T extends NodeWritable>(destination: T, options?: { end?: boolean }): T;
}
interface NodeWritable {
  write(value: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
  write(value: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean;
  end(value?: string | Uint8Array): this;
  on(event: "error", callback: (error: Error) => void): this;
  on(event: "drain" | "finish" | "close", callback: () => void): this;
}
interface NodeProcess {
  stdin: NodeReadable;
  stdout: NodeWritable;
  stderr: NodeWritable;
  env: Record<string, string | undefined>;
  argv: string[];
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
}
declare const process: NodeProcess;
declare module "fs" {
  export function readFileSync(file: number | string, options?: null | { encoding?: null }): Buffer;
  export function readFileSync(file: number | string, options: BufferEncoding | { encoding: BufferEncoding }): string;
  export function readSync(fd: number, buffer: ArrayBufferView, offset?: number, length?: number, position?: number | null): number;
  export function writeFileSync(file: number | string, data: string | ArrayBufferView, options?: BufferEncoding | { encoding?: BufferEncoding }): void;
  export function writeSync(fd: number, buffer: ArrayBufferView, offset?: number, length?: number, position?: number | null): number;
  export function writeSync(fd: number, value: string, position?: number | null, encoding?: BufferEncoding): number;
  const fs: { readFileSync: typeof readFileSync; readSync: typeof readSync; writeFileSync: typeof writeFileSync; writeSync: typeof writeSync };
  export default fs;
}
declare module "node:fs" { export * from "fs"; export { default } from "fs"; }
declare module "process" { const value: NodeProcess; export default value; export const stdin: NodeReadable; export const stdout: NodeWritable; export const stderr: NodeWritable; export const nextTick: NodeProcess["nextTick"]; export const env: NodeProcess["env"]; export const argv: string[]; }
declare module "node:process" { export * from "process"; export { default } from "process"; }
declare module "node:buffer" { export * from "buffer"; export { default } from "buffer"; }
declare module "readline" {
  export class Interface implements AsyncIterable<string> {
    constructor(options: { input: NodeReadable; output?: NodeWritable; terminal?: boolean; crlfDelay?: number });
    on(event: "line", callback: (line: string) => void): this;
    on(event: "close" | "pause" | "resume", callback: () => void): this;
    on(event: "error", callback: (error: Error) => void): this;
    close(): void;
    pause(): this;
    resume(): this;
    [Symbol.asyncIterator](): AsyncIterator<string>;
  }
  export function createInterface(options: { input: NodeReadable; output?: NodeWritable; terminal?: boolean; crlfDelay?: number }): Interface;
  const readline: { createInterface: typeof createInterface; Interface: typeof Interface };
  export default readline;
}
declare module "node:readline" { export * from "readline"; export { default } from "readline"; }
`;

export const QUICKJS_COMMONJS_DECLARATION = String.raw`
declare function require(name: "fs" | "node:fs"): typeof import("fs");
declare function require(name: "readline" | "node:readline"): typeof import("readline");
declare function require(name: "buffer" | "node:buffer"): typeof import("buffer");
declare function require(name: "process" | "node:process"): NodeProcess;
`;
