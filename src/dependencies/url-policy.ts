const IP_V4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PRIVATE_SUFFIXES = [
  "home.arpa",
  "internal",
  "intranet",
  "lan",
  "local",
  "localhost",
] as const;

/** Parses a dependency URL and rejects credentials, local names, and every IP literal. */
export function publicDependencyUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Dependency URL '${value}' is invalid.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Dependency URL '${value}' must be credential-free HTTPS without a query or fragment.`);
  }
  dependencyPublicHostname(url.hostname);
  return url;
}

/** Returns the canonical public DNS hostname used by consent records. */
export function dependencyPublicHostname(value: string): string {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname !== value.toLowerCase().replace(/\.$/, "")) {
    throw new Error(`Dependency hostname '${value}' is invalid.`);
  }
  if (isIpLiteral(hostname)) {
    throw new Error(`Dependency hostname '${value}' must not be an IP literal.`);
  }
  if (PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new Error(`Dependency hostname '${value}' is a local or private-network endpoint.`);
  }
  let canonical: URL;
  try {
    canonical = new URL(`https://${hostname}/`);
  } catch {
    throw new Error(`Dependency hostname '${value}' is invalid.`);
  }
  const normalized = canonical.hostname.toLowerCase().replace(/\.$/, "");
  if (normalized !== hostname || canonical.port || canonical.username || canonical.password) {
    throw new Error(`Dependency hostname '${value}' must be a canonical DNS hostname.`);
  }
  return normalized;
}

function isIpLiteral(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return IP_V4.test(unwrapped) || unwrapped.includes(":");
}
