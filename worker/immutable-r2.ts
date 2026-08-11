import { sha256Hex } from "./crypto";

export interface ImmutableMirroredPutResult {
  readonly primary: "created" | "reused";
  readonly mirror: "created" | "reused";
}

async function createOrReuse(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  options: R2PutOptions,
): Promise<"created" | "reused"> {
  const verifyExisting = async (existing: R2ObjectBody | null): Promise<void> => {
    if (!existing || existing.size !== bytes.byteLength || existing.customMetadata?.sha256 !== digest) {
      throw new Error("An existing content address has inconsistent metadata.");
    }
    const existingBytes = new Uint8Array(await existing.arrayBuffer());
    if (await sha256Hex(existingBytes) !== digest) throw new Error("An existing content address has inconsistent bytes.");
  };
  const existing = await bucket.get(key);
  if (existing) {
    await verifyExisting(existing);
    return "reused";
  }
  // R2's conditional create closes the get/put race. A null result means a
  // concurrent writer won; verify and reuse its exact bytes instead of
  // treating this invocation as the creator (and potentially deleting it).
  const created = await bucket.put(key, bytes, { ...options, onlyIf: { etagDoesNotMatch: "*" } });
  if (!created) {
    await verifyExisting(await bucket.get(key));
    return "reused";
  }
  const stored = await bucket.get(key);
  if (!stored || stored.size !== bytes.byteLength || stored.customMetadata?.sha256 !== digest) {
    throw new Error("A new content address failed metadata read-back.");
  }
  const storedBytes = new Uint8Array(await stored.arrayBuffer());
  if (await sha256Hex(storedBytes) !== digest) throw new Error("A new content address failed byte read-back.");
  return "created";
}

/**
 * Create missing sides or reuse exact immutable sides. Failure never deletes
 * here: another import may already have reused a newly created side after our
 * conditional PUT. The caller releases its exact D1 claim into the tokenized,
 * reference-aware GC, which is the only safe deletion authority.
 */
export async function putImmutableMirroredObject(
  primary: R2Bucket,
  mirror: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  options: R2PutOptions,
): Promise<ImmutableMirroredPutResult> {
  const primaryResult = await createOrReuse(primary, key, bytes, digest, options);
  const mirrorResult = await createOrReuse(mirror, key, bytes, digest, options);
  return { primary: primaryResult, mirror: mirrorResult };
}
