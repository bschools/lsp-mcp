import * as path from "node:path";

/**
 * Single source of truth for which files/directories warmUpWorkspace AND the
 * file watcher care about. Both must use these predicates so the eager-open
 * set and the watched set can never drift (see the buffer-sync design).
 *
 * Extensions mirror the inlined WARMUP_EXTENSIONS; skip-dirs mirror
 * WARMUP_SKIP_DIRS plus any dotdir.
 */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", "out"]);

/**
 * True for TypeScript source files the LSP should open as buffers.
 * Uses path.extname membership, mirroring warmUpWorkspace exactly — so e.g.
 * `foo.d.ts` (extname ".ts") counts, matching today's eager-open behavior.
 */
export function isWatchableSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

/**
 * True for directories the walker/watcher must NOT descend into: the explicit
 * skip-set plus any dotdir. Takes a bare directory name (not a full path).
 */
export function shouldSkipDir(dirName: string): boolean {
  return SKIP_DIRS.has(dirName) || dirName.startsWith(".");
}
