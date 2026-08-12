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

describe("document_symbols integration", () => {
  let workspace: string;
  let client: McpTestClient;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doc-symbols-"));
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

  interface SymbolsResult {
    totalSymbols: number;
    symbols: Array<{ name: string; qualifiedName: string; kind: string }>;
  }

  async function resultFor(relPath: string, name?: string): Promise<SymbolsResult> {
    const resp = await client.request("tools/call", {
      name: "document_symbols",
      arguments: {
        filePath: path.join(workspace, relPath),
        ...(name === undefined ? {} : { name }),
      },
    });
    expect(resp.error).toBeUndefined();
    const content = (resp.result as { content: { text: string }[] }).content[0].text;
    return JSON.parse(content) as SymbolsResult;
  }

  async function symbolsFor(
    relPath: string,
  ): Promise<SymbolsResult["symbols"]> {
    return (await resultFor(relPath)).symbols;
  }

  it("lists a class and its methods, parent-qualified", async () => {
    // user.repository.ts declares `class UserRepository` with findById/findAll.
    const symbols = await symbolsFor("src/user.repository.ts");

    const cls = symbols.find((s) => s.name === "UserRepository");
    expect(cls?.kind).toBe("Class");

    const qualified = symbols.map((s) => s.qualifiedName);
    expect(qualified).toContain("UserRepository.findById");
    expect(qualified).toContain("UserRepository.findAll");

    const findById = symbols.find((s) => s.qualifiedName === "UserRepository.findById");
    expect(findById?.kind).toBe("Method");
  }, 60000);

  it("answers the (path, symbolName) question with no position supplied", async () => {
    // The reason this tool exists: a caller holding only a file and a name has
    // no position to feed hover/definition, and grep cannot tell a declaration
    // from a mention in a comment or string.
    const symbols = await symbolsFor("src/user.service.ts");

    expect(symbols.map((s) => s.qualifiedName)).toContain("UserService.getName");
    expect(symbols.map((s) => s.qualifiedName)).not.toContain("UserService.noSuchMethod");
  }, 60000);

  it("filters by bare or parent-qualified name, keeping the unfiltered total", async () => {
    const all = await resultFor("src/user.repository.ts");
    expect(all.totalSymbols).toBeGreaterThan(1);

    for (const query of ["findById", "UserRepository.findById"]) {
      const filtered = await resultFor("src/user.repository.ts", query);
      expect(filtered.symbols.map((s) => s.qualifiedName)).toEqual([
        "UserRepository.findById",
      ]);
      // The total is of the file, not of the match — so "declares nothing"
      // stays distinguishable from "declares things, none of them this".
      expect(filtered.totalSymbols).toBe(all.totalSymbols);
    }
  }, 60000);

  it("reports a miss as zero matches against a non-zero total", async () => {
    const result = await resultFor("src/user.repository.ts", "noSuchMethod");

    expect(result.symbols).toHaveLength(0);
    expect(result.totalSymbols).toBeGreaterThan(0);
  }, 60000);

  it("returns an empty symbol list rather than failing on a file with no declarations", async () => {
    fs.writeFileSync(path.join(workspace, "src", "empty.ts"), "// nothing here\n");

    const symbols = await symbolsFor("src/empty.ts");

    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols).toHaveLength(0);
  }, 60000);
});
