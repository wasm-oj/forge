import { Buffer } from "buffer";
import { Readable, Writable } from "readable-stream";
import { EventEmitter } from "events";
import process from "./process.cjs";

export function createNodeStdio(input, writeStdout, writeStderr, env, args) {
  const bytes = Buffer.from(input);
  let cursor = 0;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  function descriptor(file) {
    if (file === "/dev/stdin") return 0;
    if (file === "/dev/stdout") return 1;
    if (file === "/dev/stderr") return 2;
    if (file === 0 || file === 1 || file === 2) return file;
    throw fail("ENOSYS", "Only standard input/output file descriptors are supported by this runtime.");
  }
  function readFileSync(file, options) {
    if (descriptor(file) !== 0) throw fail("EBADF", "File descriptor is not readable");
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding != null && !Buffer.isEncoding(encoding)) throw new TypeError("Unknown encoding: " + encoding);
    const result = Buffer.from(bytes.subarray(cursor));
    cursor = bytes.length;
    return encoding == null ? result : result.toString(encoding);
  }
  function readSync(file, buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
    if (descriptor(file) !== 0) throw fail("EBADF", "File descriptor is not readable");
    if (!ArrayBuffer.isView(buffer)) throw new TypeError("buffer must be an ArrayBuffer view");
    if (position != null && position !== -1) throw fail("ESPIPE", "Standard input is not seekable");
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.byteLength) throw new RangeError("Read range is outside the buffer");
    const count = Math.min(length, bytes.length - cursor);
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(bytes.subarray(cursor, cursor + count), offset);
    cursor += count;
    return count;
  }
  function writeBytes(file, data) {
    const fd = descriptor(file);
    if (fd === 0) throw fail("EBADF", "File descriptor is not writable");
    const copy = Uint8Array.from(data);
    (fd === 1 ? writeStdout : writeStderr)(copy.buffer);
    return copy.byteLength;
  }
  function writeFileSync(file, data, options) {
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (typeof data !== "string" && !ArrayBuffer.isView(data)) throw new TypeError("data must be a string or ArrayBuffer view");
    writeBytes(file, typeof data === "string" ? Buffer.from(data, encoding) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  function writeSync(file, data, offset, length, position) {
    if (typeof data === "string") {
      if (offset != null && offset !== -1) throw fail("ESPIPE", "Standard output is not seekable");
      return writeBytes(file, Buffer.from(data, typeof length === "string" ? length : "utf8"));
    }
    if (!ArrayBuffer.isView(data)) throw new TypeError("buffer must be an ArrayBuffer view");
    if (position != null && position !== -1) throw fail("ESPIPE", "Standard output is not seekable");
    offset ??= 0;
    length ??= data.byteLength - offset;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > data.byteLength) throw new RangeError("Write range is outside the buffer");
    return writeBytes(file, new Uint8Array(data.buffer, data.byteOffset + offset, length));
  }
  const stdin = new Readable({
    read(size) {
      if (cursor === bytes.length) { this.push(null); return; }
      const end = Math.min(bytes.length, cursor + size);
      const chunk = Buffer.from(bytes.subarray(cursor, end));
      cursor = end;
      this.push(chunk);
    },
  });
  function output(fd) {
    return new Writable({
      write(chunk, _encoding, callback) {
        try { writeBytes(fd, chunk); callback(); } catch (error) { callback(error); }
      },
    });
  }
  Object.assign(process, { stdin, stdout: output(1), stderr: output(2), env, argv: args });
  class Interface extends EventEmitter {
    constructor(options) {
      super();
      if (!options?.input || options.terminal) throw fail("ENOSYS", "readline supports nonterminal input streams only");
      this.input = options.input;
      this.closed = false;
      let pending = [];
      let skipLf = false;
      this.onData = (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let start = skipLf && text.startsWith("\n") ? 1 : 0;
        skipLf = false;
        const endings = /\r\n|\n|\r/g;
        endings.lastIndex = start;
        let match;
        while ((match = endings.exec(text)) !== null) {
          pending.push(text.slice(start, match.index));
          this.emit("line", pending.join(""));
          pending = [];
          start = endings.lastIndex;
          skipLf = match[0] === "\r" && start === text.length;
        }
        if (start < text.length) pending.push(text.slice(start));
      };
      this.onEnd = () => { if (pending.length) this.emit("line", pending.join("")); this.close(); };
      this.onError = (error) => this.emit("error", error);
      this.input.setEncoding("utf8");
      this.input.on("data", this.onData);
      this.input.on("end", this.onEnd);
      this.input.on("error", this.onError);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.input.pause();
      this.input.removeListener("data", this.onData);
      this.input.removeListener("end", this.onEnd);
      this.input.removeListener("error", this.onError);
      this.emit("close");
    }
    pause() { this.input.pause(); this.emit("pause"); return this; }
    resume() { this.input.resume(); this.emit("resume"); return this; }
    [Symbol.asyncIterator]() {
      const lines = [];
      const waiters = [];
      this.on("line", (line) => waiters.length ? waiters.shift()({ value: line, done: false }) : lines.push(line));
      this.on("close", () => { for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true }); });
      return {
        next: () => lines.length ? Promise.resolve({ value: lines.shift(), done: false }) : this.closed ? Promise.resolve({ value: undefined, done: true }) : new Promise((resolve) => waiters.push(resolve)),
        return: async () => { this.close(); return { value: undefined, done: true }; },
      };
    }
  }
  const fs = { readFileSync, readSync, writeFileSync, writeSync };
  const readline = { createInterface: (options) => new Interface(options), Interface };
  const buffer = { Buffer };
  const builtins = Object.create(null);
  for (const [name, value] of Object.entries({ fs, process, readline, buffer })) {
    value.default = value;
    builtins[name] = value;
    builtins["node:" + name] = value;
  }
  globalThis.Buffer = Buffer;
  globalThis.process = process;
  return { builtins, readAsString: () => readFileSync(0, "utf8") };
}
