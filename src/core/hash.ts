import type { Project } from "./types";

export async function projectCacheKey(project: Project): Promise<string> {
  const canonical = JSON.stringify({
    config: project.config,
    files: [...project.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ path, language, content }) => ({ path, language, content })),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
