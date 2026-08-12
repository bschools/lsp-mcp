import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { LspClient } from "./client.js";
import { discoverProjectRepresentatives } from "../workspace/projects.js";
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
  /** Resolves once no project load has been in flight for the settle window. Returns false on timeout. */
  waitForProjectLoad(timeoutMs?: number): Promise<boolean>;
  /** Runs a semantic request against a quiescent project graph, re-issuing it once if a load starts mid-flight. */
  runStable<T>(fn: () => Promise<T>, resyncPath?: string): Promise<T>;
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

  // tsserver loads the project graph lazily and in the background. While that
  // is in flight it still ANSWERS semantic requests — from whatever slice of
  // the graph exists at that moment, with no error and no partial marker.
  // Measured against a 2063-file monorepo: `textDocument/references` on a
  // symbol with 8 referencing files returned 4 of them at t≈5s and only
  // converged at t≈15s. Silent under-reporting on "who calls this" is worse
  // than no answer, so semantic tools gate on quiescence (see runStable).
  //
  // The server does announce the work: tsserver's projectLoadingStart/Finish
  // events surface as `$/progress` begin/end — but ONLY if the client both
  // advertises `window.workDoneProgress` and answers the server's
  // `window/workDoneProgress/create` request. Both are done here.
  const activeProgress = new Set<string>();
  // Bumped on every progress begin. runStable re-issues a request whose result
  // could have been computed against a graph that changed underneath it.
  let projectGeneration = 0;

  client.onRequest(() => null);
  client.onNotification((method, params) => {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri: string; diagnostics: Diagnostic[] };
      diagnosticsByUri.set(p.uri, p.diagnostics);
      return;
    }
    if (method === "$/progress") {
      const p = params as { token?: string | number; value?: { kind?: string } };
      const token = String(p.token ?? "");
      if (p.value?.kind === "begin") {
        activeProgress.add(token);
        projectGeneration += 1;
      } else if (p.value?.kind === "end") {
        activeProgress.delete(token);
      }
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
      // Required for tsserver's project-load progress. Without it the server
      // never reports `projectLoadingStart/Finish`, and semantic requests
      // silently answer from a half-loaded project graph.
      window: { workDoneProgress: true },
    },
    workspaceFolders: [{ uri: url.pathToFileURL(workspaceRoot).href, name: path.basename(workspaceRoot) }],
  });

  client.notify("initialized", {});

  // Open one file per configured project so tsserver has every project loaded
  // before the first rename/references call.
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
    } catch (err) {
      // ENOENT is expected: the file vanished between watcher detection and
      // read — skip silently. Any other stat/read failure (EACCES, EMFILE, …)
      // is logged to the tsserver log stream, never swallowed (AC: watcher/
      // stat/read errors are logged).
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logWatcher(`didOpen ${filePath}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
      return;
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
    } catch (err) {
      // ENOENT is expected: the file vanished between watcher detection and
      // read — skip silently. Any other stat/read failure (EACCES, EMFILE, …)
      // is logged to the tsserver log stream, never swallowed (AC: watcher/
      // stat/read errors are logged).
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logWatcher(`didChange ${filePath}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
      return;
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

  async function waitForProjectLoad(timeoutMs = PROJECT_LOAD_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let quietSince: number | undefined;
    while (Date.now() < deadline) {
      if (activeProgress.size > 0) {
        quietSince = undefined;
      } else {
        quietSince ??= Date.now();
        // A load announces itself a few hundred ms after the didOpen that
        // triggers it, so "no progress right now" is not yet "no progress
        // coming". Require the idle window to hold before declaring ready.
        if (Date.now() - quietSince >= PROJECT_SETTLE_MS) return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  async function runStable<T>(
    fn: () => Promise<T>,
    resyncPath?: string,
  ): Promise<T> {
    // Two retries beyond the first attempt. Two distinct transients are being
    // absorbed:
    //   1. A project load that starts while the request is in flight — the
    //      answer was computed against a graph that changed underneath it.
    //   2. `Debug Failure. False expression.` out of tsserver's
    //      computePositionOfLineAndCharacter, which is what a position request
    //      gets when the server has not finished taking up the didOpen for
    //      that document yet. Retrying after a beat is the documented-by-
    //      practice remedy (rename_symbol has carried its own evict-and-retry
    //      for this for as long as it has existed).
    const MAX_ATTEMPTS = 3;
    const SETTLE_RETRY_MS = 250;
    let result!: T;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const settled = await waitForProjectLoad();
      if (!settled) {
        process.stderr.write(
          `[lsp-mcp] project graph still loading after ${PROJECT_LOAD_TIMEOUT_MS}ms; ` +
            `answering from a partial graph (result may under-report)\n`,
        );
      }
      const before = projectGeneration;
      try {
        result = await fn();
      } catch (err) {
        const message = (err as { message?: string })?.message ?? "";
        if (!/Debug Failure/i.test(message) || attempt === MAX_ATTEMPTS - 1) {
          throw err;
        }
        // Resend the document before retrying: the failure is tsserver
        // computing a position against a ScriptInfo whose text it does not
        // actually hold, and a fresh didChange rebuilds it.
        if (resyncPath) await didChange(resyncPath);
        await new Promise((r) => setTimeout(r, SETTLE_RETRY_MS));
        continue;
      }
      if (projectGeneration === before) return result;
    }
    // Attempts exhausted with the graph still churning. The result stands (a
    // partial answer beats no answer) but it is exactly the silent-truncation
    // shape this module exists to close, so it does not leave unannounced.
    process.stderr.write(
      `[lsp-mcp] project graph changed under ${MAX_ATTEMPTS} consecutive attempts; ` +
        `returning the last result (may under-report)\n`,
    );
    return result;
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

  return { client, diagnosticsByUri, shutdown, didOpen, didChange, didClose, ensureFile, waitForDiagnostics, waitForProjectLoad, runStable };
}

/**
 * Read a numeric env knob, falling back on anything that is not a finite
 * number. A bare `Number(process.env.X)` turns a typo into `NaN`, and every
 * one of these knobs fails OPEN on NaN — `slice(0, NaN)` warms up zero files,
 * `Date.now() < NaN` ends the readiness wait on its first tick. That silently
 * reinstates the exact under-reporting this module exists to prevent, so a bad
 * value is announced and ignored rather than honoured.
 */
function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    process.stderr.write(
      `[lsp-mcp] ${name}="${raw}" is not a number; using ${fallback}\n`,
    );
    return fallback;
  }
  return parsed;
}

// Safety valve on the representative set, not a sampling cap: representatives
// number one per configured project (single digits on real workspaces), so the
// default is never reached in practice.
const WARMUP_MAX_FILES = numberEnv("LSP_MCP_WARMUP_MAX_FILES", 500);

// How long the "no project loading in flight" window must hold before a
// semantic request is allowed through, and the ceiling on that wait.
const PROJECT_SETTLE_MS = numberEnv("LSP_MCP_PROJECT_SETTLE_MS", 500);
const PROJECT_LOAD_TIMEOUT_MS = numberEnv(
  "LSP_MCP_PROJECT_LOAD_TIMEOUT_MS",
  60_000,
);

/**
 * Opens one file per configured project so tsserver has loaded every project
 * before the first semantic request.
 *
 * This used to breadth-first open up to 500 arbitrary source files. That is
 * the wrong axis: what makes a project's files findable is that the PROJECT is
 * loaded, and 500 files from three projects load exactly three projects — the
 * same three that three files would. Measured on a 2063-file monorepo, the
 * 500-file walk left `textDocument/references` reporting 4 of 8 referencing
 * files and made convergence SLOWER (23 s vs 15 s) by queueing 500 open
 * commands ahead of the real work; raising it to cover all 2063 files pushed
 * the first request past its 30 s timeout entirely.
 */
async function warmUpWorkspace(
  root: string,
  open: (p: string) => Promise<void>,
): Promise<void> {
  const files = discoverProjectRepresentatives(root).slice(0, WARMUP_MAX_FILES);
  for (const file of files) {
    try {
      await open(file);
    } catch {
      // Best-effort — skip unreadable files
    }
  }
}
