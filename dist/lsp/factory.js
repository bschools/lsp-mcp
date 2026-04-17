import { createLspLifecycle } from "./lifecycle.js";
const IDLE_MS = parseInt(process.env.LSP_MCP_IDLE_MS ?? "300000", 10);
const cache = new Map();
function cacheKey(workspaceRoot) {
    return workspaceRoot + ":ts";
}
export async function getOrCreateClient(workspaceRoot) {
    const key = cacheKey(workspaceRoot);
    if (cache.has(key)) {
        const entry = cache.get(key);
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
export async function evictClient(workspaceRoot) {
    const key = cacheKey(workspaceRoot);
    const entry = cache.get(key);
    if (!entry)
        return;
    clearTimeout(entry.timer);
    cache.delete(key);
    await entry.lifecycle.shutdown();
}
function createIdleTimer(key, lifecycle) {
    return setTimeout(async () => {
        cache.delete(key);
        await lifecycle.shutdown();
    }, IDLE_MS);
}
//# sourceMappingURL=factory.js.map