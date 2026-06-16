import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { LspClient } from "./client.js";
import { isWatchableSourceFile, shouldSkipDir } from "./source-filter.js";
import { createSourceWatcher, type SourceWatcher } from "./watcher.js";

export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspLifecycle {
  client: LspClient;
  diagnosticsByUri: Map<string, Diagnostic[]>;
  shutdown(): Promise<void>;
  didOpen(filePath: string): Promise<void>;
  didChange(filePath: string): Promise<void>;
  didClose(filePath: string): Promise<void>;
  ensureFile(filePath: string): Promise<void>;
  waitForDiagnostics(uri: string, timeoutMs?: number): Promise<Diagnostic[]>;
}

type OpenFileInfo = { version: number; mtimeMs: number };

export async function createLspLifecycle(
  workspaceRoot: string,
): Promise<LspLifecycle> {
  const proc = spawn("typescript-language-server", ["--stdio"], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const logDir = process.env.LSP_MCP_LOG_DIR ?? os.tmpdir();
  const logPath = path.join(logDir, `lsp-mcp-tsserver-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  if (proc.stderr) proc.stderr.pipe(logStream);

  // Watcher errors (e.g. inotify/descriptor exhaustion) go to the same log
  // stream — logged, never thrown (AC: degrade to current behavior on failure).
  function logWatcher(message: string): void {
    try {
      logStream.write(`[watcher] ${message}\n`);
    } catch {
      // logging must never throw
    }
  }

  const client = new LspClient(proc);
  const openFiles = new Map<string, OpenFileInfo>();
  const diagnosticsByUri = new Map<string, Diagnostic[]>();

  client.onNotification((method, params) => {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri: string; diagnostics: Diagnostic[] };
      diagnosticsByUri.set(p.uri, p.diagnostics);
    }
  });

  await client.request("initialize", {
    processId: process.pid,
    rootUri: url.pathToFileURL(workspaceRoot).href,
    capabilities: {
      textDocument: {
        synchronization: { didSave: false, willSave: false },
        rename: { prepareSupport: true },
        references: {},
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
      },
      workspace: {
        applyEdit: true,
        workspaceEdit: { documentChanges: true },
        fileOperations: { willRename: true, didRename: true },
      },
    },
    workspaceFolders: [{ uri: url.pathToFileURL(workspaceRoot).href, name: path.basename(workspaceRoot) }],
  });

  client.notify("initialized", {});

  // Eagerly open all .ts/.tsx files in the workspace so tsserver indexes
  // cross-file references before the first rename/references call.
  await warmUpWorkspace(workspaceRoot, (p) => didOpen(p));

  // Watch the workspace for external changes (git checkout, generators, other
  // agents) so tsserver buffers stay in sync with disk. Started AFTER warmup,
  // closed FIRST in shutdown(). LSP_MCP_NO_WATCH disables it entirely.
  let watcher: SourceWatcher | undefined;
  if (!process.env.LSP_MCP_NO_WATCH) {
    const debounceMs = Number(process.env.LSP_MCP_WATCH_DEBOUNCE_MS ?? 150);
    watcher = createSourceWatcher(workspaceRoot, {
      debounceMs,
      onChange: (p) => didChange(p),
      onAdd: async (p) => {
        const fileUri = url.pathToFileURL(p).href;
        const wasOpen = openFiles.has(fileUri);
        await didOpen(p);
        // Structural notice only for a GENUINELY new file. chokidar reports an
        // atomic rename-onto-existing path as 'add' too; deriving created-ness
        // from openFiles membership (not the raw event) avoids mislabeling a
        // content change as a create. textDocument/didChange stays authoritative
        // for already-open docs, so no redundant notice fires on pure edits.
        if (!wasOpen && openFiles.has(fileUri)) {
          client.notify("workspace/didChangeWatchedFiles", {
            changes: [{ uri: fileUri, type: 1 }], // 1 = Created
          });
        }
      },
      onUnlink: async (p) => {
        const fileUri = url.pathToFileURL(p).href;
        const wasOpen = openFiles.has(fileUri);
        await didClose(p);
        if (wasOpen) {
          client.notify("workspace/didChangeWatchedFiles", {
            changes: [{ uri: fileUri, type: 3 }], // 3 = Deleted
          });
        }
      },
      onError: (err) => logWatcher(err instanceof Error ? (err.stack ?? err.message) : String(err)),
    });
  }

  async function didOpen(filePath: string): Promise<void> {
    const fileUri = url.pathToFileURL(filePath).href;
    let stat: fs.Stats;
    let text: string;
    try {
      stat = fs.statSync(filePath);
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return; // file vanished between watcher detection and read — skip
    }

    if (openFiles.has(fileUri)) {
      // File already open — check mtime drift
      const info = openFiles.get(fileUri)!;
      if (info.mtimeMs !== stat.mtimeMs) {
        const newVersion = info.version + 1;
        openFiles.set(fileUri, { version: newVersion, mtimeMs: stat.mtimeMs });
        client.notify("textDocument/didChange", {
          textDocument: { uri: fileUri, version: newVersion },
          contentChanges: [{ text }],
        });
      }
      return;
    }

    openFiles.set(fileUri, { version: 1, mtimeMs: stat.mtimeMs });
    client.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: "typescript", version: 1, text },
    });
  }

  async function didChange(filePath: string): Promise<void> {
    const fileUri = url.pathToFileURL(filePath).href;
    let stat: fs.Stats;
    let text: string;
    try {
      stat = fs.statSync(filePath);
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return; // file vanished between watcher detection and read — skip
    }
    const info = openFiles.get(fileUri);
    const version = info ? info.version + 1 : 1;

    if (!info) {
      openFiles.set(fileUri, { version, mtimeMs: stat.mtimeMs });
      client.notify("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "typescript", version, text },
      });
    } else {
      openFiles.set(fileUri, { version, mtimeMs: stat.mtimeMs });
      client.notify("textDocument/didChange", {
        textDocument: { uri: fileUri, version },
        contentChanges: [{ text }],
      });
    }
  }

  async function didClose(filePath: string): Promise<void> {
    const fileUri = url.pathToFileURL(filePath).href;
    if (!openFiles.has(fileUri)) return;
    openFiles.delete(fileUri);
    client.notify("textDocument/didClose", { textDocument: { uri: fileUri } });
  }

  async function ensureFile(filePath: string): Promise<void> {
    await didOpen(filePath);
  }

  async function waitForDiagnostics(uri: string, timeoutMs = 5000): Promise<Diagnostic[]> {
    // tsserver emits two publishDiagnostics rounds per file: syntactic (fast, may be [])
    // then semantic (may carry real errors). We wait for the first notification to arrive,
    // then allow up to SETTLE_MS more for the semantic pass before returning.
    const SETTLE_MS = 2500;
    const deadline = Date.now() + timeoutMs;
    let firstSeenAt: number | undefined;

    while (Date.now() < deadline) {
      const current = diagnosticsByUri.get(uri);
      if (current !== undefined) {
        if (current.length > 0) return current;
        if (firstSeenAt === undefined) firstSeenAt = Date.now();
        if (Date.now() - firstSeenAt >= SETTLE_MS) return current;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return diagnosticsByUri.get(uri) ?? [];
  }

  async function shutdown(): Promise<void> {
    // Close the watcher FIRST so no late event reopens a buffer mid-shutdown.
    if (watcher) {
      try {
        await watcher.close();
      } catch {
        // best-effort
      }
      watcher = undefined;
    }

    // Close all tracked files
    for (const uri of openFiles.keys()) {
      client.notify("textDocument/didClose", { textDocument: { uri } });
    }
    openFiles.clear();

    try {
      await client.request("shutdown");
      client.notify("exit");
    } catch {
      // Best-effort
    }
    proc.kill();
  }

  return { client, diagnosticsByUri, shutdown, didOpen, didChange, didClose, ensureFile, waitForDiagnostics };
}

const WARMUP_MAX_FILES = 500;

async function warmUpWorkspace(
  root: string,
  open: (p: string) => Promise<void>,
): Promise<void> {
  const files: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && files.length < WARMUP_MAX_FILES) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (isWatchableSourceFile(entry.name)) {
          files.push(path.join(dir, entry.name));
          if (files.length >= WARMUP_MAX_FILES) break;
        }
      }
    }
  }

  for (const file of files) {
    try {
      await open(file);
    } catch {
      // Best-effort — skip unreadable files
    }
  }
}
