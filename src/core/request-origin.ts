export interface RequestOriginHeaders {
  forwardedHost: string | null;
  forwardedProtocol: string | null;
  host: string | null;
}

/** Resolve the public request origin without misclassifying direct loopback HTTP. */
export function resolveRequestOrigin(headers: RequestOriginHeaders): URL {
  const authority = firstForwardedValue(headers.forwardedHost) ?? headers.host?.trim();
  if (!authority) throw new Error("The request is missing its host authority.");

  let origin: URL;
  try {
    origin = new URL(`http://${authority}`);
  } catch {
    throw new Error("The request contains an invalid host authority.");
  }
  if (
    origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("The request contains an invalid host authority.");
  }

  const forwardedProtocol = firstForwardedValue(headers.forwardedProtocol);
  if (forwardedProtocol !== undefined && forwardedProtocol !== "http" && forwardedProtocol !== "https") {
    throw new Error("The request contains an invalid forwarded protocol.");
  }
  origin.protocol = `${forwardedProtocol ?? (isLoopback(origin.hostname) ? "http" : "https")}:`;
  return origin;
}

function firstForwardedValue(value: string | null): string | undefined {
  const first = value?.split(",", 1)[0]?.trim();
  return first || undefined;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
