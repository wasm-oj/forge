export interface FileTreeIdentity {
  readonly entries: number;
  readonly rootSha256: string;
}

export interface FileTreeRegularEntry {
  readonly path: string;
  readonly executable: boolean;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FileTreeSymlinkEntry {
  readonly path: string;
  readonly symlinkTarget: string;
}

export interface FileTreeInventory {
  readonly entries: readonly (FileTreeRegularEntry | FileTreeSymlinkEntry)[];
  readonly rootSha256: string;
}

/** wasm-oj-file-tree-sha256-v1 over one non-symlink directory tree. */
export function computeFileTreeIdentity(root: string, options?: {
  readonly excludedRelativePaths?: readonly string[];
  readonly allowInternalSymlinks?: boolean;
}): Promise<FileTreeIdentity>;

export function computeFileTreeInventory(root: string, options?: {
  readonly excludedRelativePaths?: readonly string[];
  readonly allowInternalSymlinks?: boolean;
}): Promise<FileTreeInventory>;

export function deriveFileTreeInventory(
  inventory: FileTreeInventory,
  relativeRoot: string,
  options?: { readonly allowInternalSymlinks?: boolean },
): FileTreeInventory;
