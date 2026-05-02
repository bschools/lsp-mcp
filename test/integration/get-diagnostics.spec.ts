import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

const FIXTURE_SRC = path.resolve(__dirname, "../fixtures/ts-sample");

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

  constructor(binPath: string, cwd: string) {
    this.proc = spawn("node", [binPath], { cwd, stdio: "pipe" });
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

function copyFixture(dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(path.join(dest, "src"), { recursive: true });
  for (const f of ["tsconfig.json", "package.json"]) {
    fs.copyFileSync(path.join(FIXTURE_SRC, f), path.join(dest, f));
  }
  for (const f of fs.readdirSync(path.join(FIXTURE_SRC, "src"))) {
    fs.copyFileSync(path.join(FIXTURE_SRC, "src", f), path.join(dest, "src", f));
  }
  fs.symlinkSync(
    path.join(LSP_MCP_ROOT, "node_modules"),
    path.join(dest, "node_modules"),
    "dir",
  );
}

describe("get_diagnostics integration", () => {
  let workspace: string;
  let client: McpTestClient;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "get-diag-"));
    copyFixture(workspace);
    client = new McpTestClient(binPath, workspace);

    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    client.notify("notifications/initialized", {});
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("returns empty diagnostics for a valid file", async () => {
    const target = path.join(workspace, "src", "user.service.ts");

    const resp = await client.request("tools/call", {
      name: "get_diagnostics",
      arguments: { filePath: target },
    });

    expect(resp.error).toBeUndefined();
    const content = (resp.result as { content: { text: string }[] }).content[0].text;
    const result = JSON.parse(content) as { filePath: string; diagnostics: unknown[] };

    expect(result.filePath).toBe(target);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  }, 60000);

  it("returns a valid response structure for any file", async () => {
    const target = path.join(workspace, "src", "broken.ts");
    fs.writeFileSync(target, 'const x: number = "not a number";\n');

    const resp = await client.request("tools/call", {
      name: "get_diagnostics",
      arguments: { filePath: target },
    });

    expect(resp.error).toBeUndefined();
    const content = (resp.result as { content: { text: string }[] }).content[0].text;
    const result = JSON.parse(content) as { filePath: string; diagnostics: unknown[] };

    expect(result.filePath).toBe(target);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  }, 60000);
});
