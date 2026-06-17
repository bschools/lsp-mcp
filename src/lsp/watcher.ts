import { watch } from "chokidar";
import type { Stats } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { isWatchableSourceFile, shouldSkipDir } from "./source-filter.js";

export type SourceWatcherOptions = {
  /** Path exists at flush AND was already known to the watcher → content change. */
  onChange: (filePath: string) => void | Promise<void>;
  /** Path exists at flush AND is newly seen by the watcher → newly tracked file. */
  onAdd: (filePath: string) => void | Promise<void>;
  /** Path is gone at flush AND was known to the watcher → removed. */
  onUnlink: (filePath: string) => void | Promise<void>;
  /** Per-path coalescing window in ms (default 150). */
  debounceMs?: number;
  /** Watcher/error sink. The watcher logs and never throws. */
  onError?: (err: unknown) => void;
};

export type SourceWatcher = {
  close(): Promise<void>;
};

/**
 * Recursively watch `root` for TypeScript source changes and drive buffer-sync
 * callbacks. Uses the shared predicate so the watched set cannot drift from
 * warmUpWorkspace's eager-open set.
 *
 * Per-path events are coalesced within `debounceMs` and resolved by FINAL
 * on-disk existence (not by last raw event type), so an atomic rename
 * (unlink+add) or a change+unlink burst converges to the correct buffer state
 * and `onUnlink` never fires on a path that still exists.
 */
export function createSourceWatcher(root: string, opts: SourceWatcherOptions): SourceWatcher {
  const debounceMs = opts.debounceMs ?? 150;
  const resolvedRoot = path.resolve(root);

  // Paths the watcher has already reported. Starts empty: ignoreInitial skips
  // the warmup-time files, which lifecycle already opened.
  const known = new Set<string>();
  // Per-path debounce timers; collapse a burst of raw events into one flush.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Paths for which chokidar fired a raw `add` in the current (pending) burst.
  // chokidar fires `add` only for genuinely-new paths and `change` for files it
  // already tracked — including pre-existing files whose initial scan was
  // suppressed by ignoreInitial. So THIS, not the `known` set, is the
  // authoritative add-vs-change discriminator: a pre-existing file's first edit
  // arrives as `change` and must resolve to onChange, not onAdd.
  const pendingAdds = new Set<string>();

  const watcher = watch(root, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
    // chokidar v4 invokes `ignored` on directories AND files, sometimes before
    // it has stat'd the path. CRITICAL: a directory must be ignored ONLY when
    // shouldSkipDir is true — never via the file-extension test, or chokidar
    // stops descending and the watcher silently observes nothing. When stats is
    // not yet available we return false (don't ignore) so chokidar stats the
    // path and re-invokes us with stats, exactly as the v4 docs prescribe.
    ignored: (p: string, stats?: Stats): boolean => {
      if (!stats) return false;
      if (stats.isDirectory()) {
        if (path.resolve(p) === resolvedRoot) return false; // always descend the root
        return shouldSkipDir(path.basename(p));
      }
      return !isWatchableSourceFile(p);
    },
  });

  function schedule(filePath: string, isAdd: boolean): void {
    if (isAdd) pendingAdds.add(filePath);
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);
    timers.set(
      filePath,
      setTimeout(() => {
        timers.delete(filePath);
        void flush(filePath);
      }, debounceMs),
    );
  }

  async function flush(filePath: string): Promise<void> {
    const sawAdd = pendingAdds.delete(filePath);
    const exists = fs.existsSync(filePath);
    try {
      if (exists) {
        // onAdd ONLY for a genuinely-new path: chokidar fired a raw `add` AND we
        // have not already reported this path. Everything else that exists is a
        // content change — crucially a pre-existing file's first edit, which
        // chokidar reports as `change` (its initial scan was suppressed by
        // ignoreInitial). Classifying by the raw event, not by `known`, stops
        // that first edit from being mislabeled a new file.
        if (sawAdd && !known.has(filePath)) {
          known.add(filePath);
          await opts.onAdd(filePath);
        } else {
          known.add(filePath);
          await opts.onChange(filePath);
        }
      } else {
        // Gone at flush → always onUnlink. The watcher's `known` set is NOT the
        // source of truth for what's tracked (warmup-opened files were skipped
        // by ignoreInitial and are absent here), so gating onUnlink on `known`
        // would miss external deletes of warmed-up dependency files — the exact
        // git-checkout case. The lifecycle's didClose no-ops on untracked paths,
        // so an onUnlink for a never-tracked path is harmless.
        known.delete(filePath);
        await opts.onUnlink(filePath);
      }
    } catch (err) {
      opts.onError?.(err);
    }
  }

  watcher.on("add", (p) => schedule(p, true));
  watcher.on("change", (p) => schedule(p, false));
  watcher.on("unlink", (p) => schedule(p, false));
  watcher.on("error", (err) => opts.onError?.(err));

  return {
    async close(): Promise<void> {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      pendingAdds.clear();
      await watcher.close();
    },
  };
}
