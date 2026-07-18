export interface FileState {
  path: string;
  mtime: number;
  size: number;
  hash: string;
}

/**
 * Per-file change detection (review-fix-4): compare (mtime, size), NOT a global
 * watermark — Syncthing preserves the origin mtime, so a file can arrive with an
 * mtime earlier than the last reindex; a watermark would silently skip it.
 */
export function needsReindex(prev: FileState | undefined, curr: { mtime: number; size: number }): boolean {
  if (!prev) return true;
  return prev.mtime !== curr.mtime || prev.size !== curr.size;
}
