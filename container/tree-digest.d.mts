export interface FileTreeIdentity {
  readonly entries: number;
  readonly rootSha256: string;
}

/** forge-file-tree-sha256-v1 over one non-symlink directory tree. */
export function computeFileTreeIdentity(root: string, options?: {
  readonly excludedRelativePaths?: readonly string[];
  readonly allowInternalSymlinks?: boolean;
}): Promise<FileTreeIdentity>;
