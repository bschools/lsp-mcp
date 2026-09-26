import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
}

class McpTestClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();

  constructor(binPath: string, cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.proc = spawn("node", [binPath], { cwd, env, stdio: "pipe" });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  send(message: unknown): void {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    this.proc.kill();
    await new Promise((r) => setTimeout(r, 100));
  }
}

const LSP_MCP_ROOT = path.resolve(__dirname, "../..");
const BIN_PATH = path.resolve(LSP_MCP_ROOT, "dist/bin.js");

const COMPILER_OPTIONS = {
  composite: true,
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  strict: true,
  skipLibCheck: true,
};

// A solution-style root (`files: []`) referencing two projects: every file
// lives in a sub-project, so nothing semantic is answerable until they load.
// The root still carries compilerOptions so workspace detection stops here.
const WORKSPACE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "multi-project", private: true, type: "module" }, null, 2),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: { skipLibCheck: true },
      files: [],
      references: [{ path: "./packages/core" }, { path: "./packages/app" }],
    },
    null,
    2,
  ),
  "packages/core/tsconfig.json": JSON.stringify(
    { compilerOptions: COMPILER_OPTIONS, include: ["src/**/*"] },
    null,
    2,
  ),
  "packages/core/src/greet.ts": [
    "export function greet(name: string): string {",
    "  return `hello ${name}`;",
    "}",
    "",
    "export function shout(name: string): string {",
    "  return greet(name).toUpperCase();",
    "}",
    "",
  ].join("\n"),
  "packages/app/tsconfig.json": JSON.stringify(
    {
      compilerOptions: COMPILER_OPTIONS,
      references: [{ path: "../core" }],
      include: ["src/**/*"],
    },
    null,
    2,
  ),
  "packages/app/src/main.ts": [
    'import { greet } from "../../core/src/greet.js";',
    "",
    'export const message = greet("world");',
    "",
  ].join("\n"),
};

const GREET = "packages/core/src/greet.ts";
const MAIN = "packages/app/src/main.ts";

function buildWorkspace(root: string): void {
  for (const [rel, content] of Object.entries(WORKSPACE_FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  // Symlink node_modules so typescript-language-server can resolve `typescript`
  fs.symlinkSync(path.join(LSP_MCP_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
}

/** Every workspace file (node_modules excluded) as relative path -> exact bytes. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function initialize(client: McpTestClient): Promise<void> {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  client.notify("notifications/initialized", {});
}

async function callTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await client.request("tools/call", { name, arguments: args });
  expect(resp.error).toBeUndefined();
  const text = (resp.result as { content: { text: string }[] }).content[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

function expectProjectLoading(result: Record<string, unknown>): void {
  expect(result).toMatchObject({
    complete: false,
    code: "project_loading",
    retryable: true,
  });
  expect(typeof result.retryAfterMs).toBe("number");
  expect(typeof result.elapsedMs).toBe("number");
  expect(typeof result.attempts).toBe("number");
  expect(typeof result.activeProjectLoads).toBe("number");
}

describe("readiness: incomplete project graph", () => {
  let workspace: string;
  let client: McpTestClient;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-incomplete-"));
    buildWorkspace(workspace);
    // The settle window is 500 ms, so a 1 ms load ceiling can never be met:
    // every gated request fails readiness deterministically.
    client = new McpTestClient(BIN_PATH, workspace, {
      ...process.env,
      LSP_MCP_PROJECT_LOAD_TIMEOUT_MS: "1",
    });
    await initialize(client);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("find_references, go_to_definition, and get_diagnostics return a typed project_loading incomplete", async () => {
    const greet = path.join(workspace, GREET);
    const main = path.join(workspace, MAIN);

    const refs = await callTool(client, "find_references", { filePath: greet, line: 0, column: 16 });
    expectProjectLoading(refs);

    const definition = await callTool(client, "go_to_definition", { filePath: main, line: 2, column: 23 });
    expectProjectLoading(definition);

    const diagnostics = await callTool(client, "get_diagnostics", { filePath: main });
    expectProjectLoading(diagnostics);
  }, 60000);

  it("rename_symbol, rename_file, and move_function refuse and leave every file byte-identical", async () => {
    const greet = path.join(workspace, GREET);
    const before = snapshot(workspace);

    const rename = await callTool(client, "rename_symbol", {
      filePath: greet,
      line: 0,
      column: 16,
      newName: "welcome",
    });
    expectProjectLoading(rename);
    expect(rename).toMatchObject({ ok: false, filesChanged: [] });

    const renameFile = await callTool(client, "rename_file", {
      oldPath: greet,
      newPath: path.join(workspace, "packages/core/src/salute.ts"),
    });
    expectProjectLoading(renameFile);
    expect(renameFile).toMatchObject({ ok: false, filesChanged: [] });

    const move = await callTool(client, "move_function", {
      filePath: greet,
      line: 4,
      column: 16,
      destinationFile: path.join(workspace, "packages/core/src/loud.ts"),
    });
    expectProjectLoading(move);
    expect(move).toMatchObject({ ok: false, filesChanged: [] });

    expect(snapshot(workspace)).toEqual(before);
  }, 60000);
});

describe("readiness: settled project graph (control)", () => {
  let workspace: string;
  let client: McpTestClient;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-control-"));
    buildWorkspace(workspace);
    client = new McpTestClient(BIN_PATH, workspace);
    await initialize(client);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("returns complete results across both projects and completes the move_function request sequence", async () => {
    const greet = path.join(workspace, GREET);
    const main = path.join(workspace, MAIN);

    // Queried from the app side: its program spans both projects.
    const refs = await callTool(client, "find_references", { filePath: main, line: 2, column: 23 });
    expect(refs.complete).not.toBe(false);
    const refPaths = (refs.files as Array<{ path: string }>).map((f) => path.relative(workspace, f.path));
    expect(refPaths).toContain(GREET);
    expect(refPaths).toContain(MAIN);

    const definition = await callTool(client, "go_to_definition", { filePath: main, line: 2, column: 23 });
    expect(definition.complete).not.toBe(false);
    expect(JSON.stringify(definition)).toContain("greet.ts");

    const diagnostics = await callTool(client, "get_diagnostics", { filePath: main });
    expect(diagnostics.complete).not.toBe(false);
    expect(Array.isArray(diagnostics.diagnostics)).toBe(true);

    // The codeAction + codeAction/resolve pair runs inside one runStable
    // callback; a settled graph lets both requests run and the tool reach its
    // own post-request verdict. typescript-language-server does not honor a
    // destination through codeAction/resolve, so that verdict is
    // destination_unsupported rather than an applied edit.
    const before = snapshot(workspace);
    const move = await callTool(client, "move_function", {
      filePath: greet,
      line: 4,
      column: 16,
      destinationFile: path.join(workspace, "packages/core/src/loud.ts"),
    });
    expect(move.complete, JSON.stringify(move)).not.toBe(false);
    expect(move).toMatchObject({ ok: false, filesChanged: [], code: "destination_unsupported" });
    expect(snapshot(workspace)).toEqual(before);
  }, 120000);
});
