/// <reference lib="webworker" />

import { ThreadPoolWorker, initSync, setRegistry, setSDKUrl } from "@wasmer/sdk";
import {
  isWasmerThreadInitMessage,
  WASMER_THREAD_STACK_SIZE_BYTES,
  type WasmerThreadInitMessage,
} from "./wasmer-thread-policy";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const pendingMessages: unknown[] = [];
let worker: ThreadPoolWorker | undefined;
let initialization: Promise<void> | undefined;

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (isWasmerThreadInitMessage(event.data)) {
    if (initialization) {
      reportFailure(new Error("A Wasmer thread worker received more than one initialization message."));
      return;
    }
    initialization = initialize(event.data);
    void initialization.catch(reportFailure);
    return;
  }
  if (!worker) {
    pendingMessages.push(event.data);
    return;
  }
  void worker.handle(event.data).catch(reportFailure);
});

async function initialize(message: WasmerThreadInitMessage): Promise<void> {
  setRegistry({});
  initSync({
    module: message.module,
    memory: message.memory,
    thread_stack_size: WASMER_THREAD_STACK_SIZE_BYTES,
  });
  setSDKUrl(message.sdkUrl);
  const initializedWorker = new ThreadPoolWorker(message.id);
  worker = initializedWorker;
  for (const pending of pendingMessages.splice(0)) await initializedWorker.handle(pending);
}

function reportFailure(reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  queueMicrotask(() => {
    throw error;
  });
}

export {};
