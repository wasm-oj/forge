/**
 * Keep Node alive while a promise is backed only by a foreign async runtime.
 * Top-level await does not itself create a referenced libuv handle, so Node can
 * otherwise exit with code 13 while a Wasmer SDK operation is still pending.
 */
export async function withProcessKeepalive(promise) {
  const keepalive = setInterval(() => undefined, 60_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepalive);
  }
}
