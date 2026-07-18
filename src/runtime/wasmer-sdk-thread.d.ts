import "@wasmer/sdk";

declare module "@wasmer/sdk" {
  /** Internal worker primitive exported and used by the pinned official SDK worker entry. */
  export class ThreadPoolWorker {
    constructor(id: number);
    handle(message: unknown): Promise<unknown>;
  }
}
