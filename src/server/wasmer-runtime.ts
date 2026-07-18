import { init } from "@wasmer/sdk/node";

let initialization: Promise<void> | undefined;

export async function initializeServerWasmerSdk(): Promise<void> {
  initialization ??= init({ log: "error" }).then(() => undefined);
  try {
    await initialization;
  } catch (error) {
    initialization = undefined;
    throw error;
  }
}
