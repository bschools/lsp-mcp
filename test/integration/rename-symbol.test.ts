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
  params?: unknown;
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

  send(message: JsonRpcMessage): void {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params } as JsonRpcMessage);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params } as JsonRpcMessage);
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
    fs.copyFileSync(
      path.join(FIXTURE_SRC, "src", f),
      path.join(dest, "src", f),
    );
  }
  // Symlink node_modules so typescript-language-server can resolve `typescript`
  fs.symlinkSync(
    path.join(LSP_MCP_ROOT, "node_modules"),
    path.join(dest, "node_modules"),
    "dir",
  );
}

describe("rename_symbol integration", () => {
  let workspace: string;
  let client: McpTestClient;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rename-sym-"));
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

  it("renames UserService -> AccountService and propagates to spec/consumer files", async () => {
    const target = path.join(workspace, "src", "user.service.ts");

    const resp = await client.request("tools/call", {
      name: "rename_symbol",
      arguments: { filePath: target, line: 0, column: 13, newName: "AccountService" },
    });

    expect(resp.error).toBeUndefined();
    const content = (resp.result as { content: { text: string }[] }).content[0].text;
    if (content.startsWith("[")) throw new Error(`Unexpected resp: ${JSON.stringify(resp.result)}`);
    const result = JSON.parse(content) as {
      ok: boolean;
      filesChanged: string[];
      lingeringReferences: string[];
    };

    if (!result.ok) throw new Error(`Rename failed: ${JSON.stringify(result)}`);
    expect(result.ok).toBe(true);

    // Declaration site must be renamed
    const svcContent = fs.readFileSync(target, "utf8");
    expect(svcContent).toContain("class AccountService");
    expect(svcContent).not.toContain("class UserService");

    // Consumer must be renamed (imports UserService directly — tsserver sees it)
    const consumerContent = fs.readFileSync(
      path.join(workspace, "src", "consumer.ts"),
      "utf8",
    );
    expect(consumerContent).toContain("AccountService");
    expect(consumerContent).not.toContain("UserService");

    // Spec file: code references (imports, constructor calls) should be renamed.
    // String-literal occurrences like describe("UserService", ...) are not
    // code references and LSP correctly leaves them alone.
    const specPath = path.join(workspace, "src", "user.service.spec.ts");
    const specContent = fs.readFileSync(specPath, "utf8");
    expect(specContent).toContain("{ AccountService }");
    expect(specContent).toContain("new AccountService()");
  }, 60000);
});
