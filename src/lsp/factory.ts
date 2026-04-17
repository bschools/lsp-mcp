import { LspLifecycle, createLspLifecycle } from "./lifecycle.js";

const IDLE_MS = parseInt(process.env.LSP_MCP_IDLE_MS ?? "300000", 10);

interface CacheEntry {
  lifecycle: LspLifecycle;
  timer: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceRoot: string): string {
  return workspaceRoot + ":ts";
}

export async function getOrCreateClient(workspaceRoot: string): Promise<LspLifecycle> {
  const key = cacheKey(workspaceRoot);

  if (cache.has(key)) {
    const entry = cache.get(key)!;
    // Reset idle timer
    clearTimeout(entry.timer);
    entry.timer = createIdleTimer(key, entry.lifecycle);
    return entry.lifecycle;
  }

  const lifecycle = await createLspLifecycle(workspaceRoot);
  const timer = createIdleTimer(key, lifecycle);
  cache.set(key, { lifecycle, timer });
  return lifecycle;
}

export async function evictClient(workspaceRoot: string): Promise<void> {
  const key = cacheKey(workspaceRoot);
  const entry = cache.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  cache.delete(key);
  await entry.lifecycle.shutdown();
}

function createIdleTimer(key: string, lifecycle: LspLifecycle): ReturnType<typeof setTimeout> {
  return setTimeout(async () => {
    cache.delete(key);
    await lifecycle.shutdown();
  }, IDLE_MS);
}
