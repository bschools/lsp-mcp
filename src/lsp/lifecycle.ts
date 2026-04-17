import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { LspClient } from "./client.js";

export interface LspLifecycle {
  client: LspClient;
  shutdown(): Promise<void>;
  didOpen(filePath: string): Promise<void>;
  didChange(filePath: string): Promise<void>;
  didClose(filePath: string): Promise<void>;
  ensureFile(filePath: string): Promise<void>;
}

type OpenFileInfo = { version: number; mtimeMs: number };

export async function createLspLifecycle(
  workspaceRoot: string,
): Promise<LspLifecycle> {
  const proc = spawn("typescript-language-server", ["--stdio"], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (proc.stderr) {
    const logDir = process.env.LSP_MCP_LOG_DIR ?? os.tmpdir();
    const logPath = path.join(logDir, `lsp-mcp-tsserver-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    proc.stderr.pipe(logStream);
  }

  const client = new LspClient(proc);
  const openFiles = new Map<string, OpenFileInfo>();

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

  async function didOpen(filePath: string): Promise<void> {
    const fileUri = url.pathToFileURL(filePath).href;
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, "utf8");

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
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, "utf8");
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

  async function shutdown(): Promise<void> {
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

  return { client, shutdown, didOpen, didChange, didClose, ensureFile };
}
