export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const encoder = new TextEncoder();

function canonicalValue(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must be a safe integer.`);
    }
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(`${path} is not canonical JSON data.`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle.`);
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${path}[${index}]`, nextAncestors));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [
    key,
    canonicalValue(record[key], `${path}.${key}`, nextAncestors),
  ]));
}

/** Forge canonical JSON: sorted object keys, safe integers, UTF-8, and one trailing newline. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(canonicalValue(value, "$", new Set()))}\n`);
}

export function parseCanonicalJsonBytes(bytes: Uint8Array, label = "value"): CanonicalJsonValue {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8 JSON.`, { cause: error });
  }
  const canonical = canonicalJsonBytes(value);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError(`${label} is not encoded as Forge canonical JSON.`);
  }
  return value as CanonicalJsonValue;
}
