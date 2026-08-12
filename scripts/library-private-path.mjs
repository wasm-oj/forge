/** Match one absolute repository path as a token, not as a suffix of another path. */
export function containsPrivateSourcePath(source, repositoryRoot) {
  if (typeof source !== "string" || typeof repositoryRoot !== "string") {
    throw new TypeError("Private source-path detection requires strings.");
  }
  const normalizedRoot = repositoryRoot.replaceAll("\\", "/").replace(/\/$/u, "");
  if (!normalizedRoot || normalizedRoot === "/") {
    throw new TypeError("Repository root must be a concrete absolute directory.");
  }
  const normalizedSource = source.replaceAll("\\", "/");
  let offset = 0;
  while ((offset = normalizedSource.indexOf(normalizedRoot, offset)) >= 0) {
    const before = offset === 0 ? undefined : normalizedSource[offset - 1];
    const afterOffset = offset + normalizedRoot.length;
    const after = afterOffset === normalizedSource.length ? undefined : normalizedSource[afterOffset];
    const tokenCharacter = /[A-Za-z0-9._~%-]/u;
    if ((before === undefined || !tokenCharacter.test(before)) && (after === undefined || !tokenCharacter.test(after))) {
      return true;
    }
    offset += normalizedRoot.length;
  }
  return false;
}
