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

describe("rename_file integration", () => {
  let workspace: string;
  let client: McpTestClient;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rename-file-"));
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

  it("renames compound-extension file into subdirectory and updates imports", async () => {
    const oldPath = path.join(workspace, "src", "plan-metadata.schema.ts");
    const newPath = path.join(workspace, "src", "schemas", "plan-metadata.schema.ts");

    const resp = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath, newPath },
    });

    expect(resp.error).toBeUndefined();

    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);

    const consumerContent = fs.readFileSync(
      path.join(workspace, "src", "schema-consumer.ts"),
      "utf8",
    );
    // Import must reference the new subdirectory path exactly once — no mangling
    expect(consumerContent).toContain("./schemas/plan-metadata.schema");
    expect(consumerContent).not.toContain("./plan-metadata.schema");
    // Regression guard: mangled double-suffix must not appear
    expect(consumerContent).not.toMatch(/plan-metadata\.schema[^'".]*\.schema/);
  }, 60000);

  it("sequentially renames compound-extension .ts then .spec.ts into subdirectory", async () => {
    const oldTs = path.join(workspace, "src", "plan-metadata.schema.ts");
    const newTs = path.join(workspace, "src", "schemas", "plan-metadata.schema.ts");
    const oldSpec = path.join(workspace, "src", "plan-metadata.schema.spec.ts");
    const newSpec = path.join(workspace, "src", "schemas", "plan-metadata.schema.spec.ts");

    // Rename source file first, then spec — mirrors the real incident
    const resp1 = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath: oldTs, newPath: newTs },
    });
    expect(resp1.error).toBeUndefined();

    const resp2 = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath: oldSpec, newPath: newSpec },
    });
    expect(resp2.error).toBeUndefined();

    expect(fs.existsSync(newTs)).toBe(true);
    expect(fs.existsSync(newSpec)).toBe(true);

    const specContent = fs.readFileSync(newSpec, "utf8");
    const consumerContent = fs.readFileSync(
      path.join(workspace, "src", "schema-consumer.ts"),
      "utf8",
    );

    // Spec must import from same-directory path (both files moved together)
    expect(specContent).toContain("./plan-metadata.schema");
    expect(specContent).not.toMatch(/plan-metadata\.schema[^'".]*\.schema/);

    // Consumer must reference new subdir path exactly
    expect(consumerContent).toContain("./schemas/plan-metadata.schema");
    expect(consumerContent).not.toContain("./plan-metadata.schema");
    expect(consumerContent).not.toMatch(/plan-metadata\.schema[^'".]*\.schema/);
  }, 60000);

  it("renames user.service.ts -> account.service.ts and updates imports", async () => {
    const oldPath = path.join(workspace, "src", "user.service.ts");
    const newPath = path.join(workspace, "src", "account.service.ts");

    const resp = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath, newPath },
    });

    expect(resp.error).toBeUndefined();

    // File must exist at new location
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);

    // Consumer/spec imports should now reference new path
    const consumerContent = fs.readFileSync(
      path.join(workspace, "src", "consumer.ts"),
      "utf8",
    );
    expect(consumerContent).toContain("./account.service");
    expect(consumerContent).not.toContain("./user.service");

    const specContent = fs.readFileSync(
      path.join(workspace, "src", "user.service.spec.ts"),
      "utf8",
    );
    expect(specContent).toContain("./account.service");
    expect(specContent).not.toContain("./user.service");
  }, 60000);
});

// ── Bundler-resolution suite (mirrors PersonaMind: ESNext + moduleResolution:bundler) ──

const BUNDLER_FIXTURE_SRC = path.resolve(__dirname, "../fixtures/ts-bundler");

function copyBundlerFixture(dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(path.join(dest, "src"), { recursive: true });
  for (const f of ["tsconfig.json", "package.json"]) {
    fs.copyFileSync(path.join(BUNDLER_FIXTURE_SRC, f), path.join(dest, f));
  }
  for (const f of fs.readdirSync(path.join(BUNDLER_FIXTURE_SRC, "src"))) {
    fs.copyFileSync(path.join(BUNDLER_FIXTURE_SRC, "src", f), path.join(dest, "src", f));
  }
  fs.symlinkSync(
    path.join(LSP_MCP_ROOT, "node_modules"),
    path.join(dest, "node_modules"),
    "dir",
  );
}

describe("rename_file integration (bundler resolution)", () => {
  let workspace: string;
  let client: McpTestClient;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rename-bundler-"));
    copyBundlerFixture(workspace);
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

  it("renames compound-extension file into subdirectory (extensionless imports)", async () => {
    const oldPath = path.join(workspace, "src", "plan-metadata.schema.ts");
    const newPath = path.join(workspace, "src", "schemas", "plan-metadata.schema.ts");

    const resp = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath, newPath },
    });

    expect(resp.error).toBeUndefined();
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);

    const consumerContent = fs.readFileSync(
      path.join(workspace, "src", "schema-consumer.ts"),
      "utf8",
    );
    expect(consumerContent).toContain("./schemas/plan-metadata.schema");
    expect(consumerContent).not.toContain('"./plan-metadata.schema"');
    // Regression guard: catches plan-metadata.schemaa.schema and similar manglings
    expect(consumerContent).not.toMatch(/plan-metadata\.schema[^'"\s]*\.schema/);
  }, 60000);

  it("sequentially renames .ts then .spec.ts into subdirectory (bundler, extensionless)", async () => {
    const oldTs = path.join(workspace, "src", "plan-metadata.schema.ts");
    const newTs = path.join(workspace, "src", "schemas", "plan-metadata.schema.ts");
    const oldSpec = path.join(workspace, "src", "plan-metadata.schema.spec.ts");
    const newSpec = path.join(workspace, "src", "schemas", "plan-metadata.schema.spec.ts");

    const resp1 = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath: oldTs, newPath: newTs },
    });
    expect(resp1.error).toBeUndefined();

    const resp2 = await client.request("tools/call", {
      name: "rename_file",
      arguments: { oldPath: oldSpec, newPath: newSpec },
    });
    expect(resp2.error).toBeUndefined();

    expect(fs.existsSync(newTs)).toBe(true);
    expect(fs.existsSync(newSpec)).toBe(true);

    const specContent = fs.readFileSync(newSpec, "utf8");
    const consumerContent = fs.readFileSync(
      path.join(workspace, "src", "schema-consumer.ts"),
      "utf8",
    );

    expect(specContent).toContain("./plan-metadata.schema");
    expect(specContent).not.toMatch(/plan-metadata\.schema[^'"\s]*\.schema/);

    expect(consumerContent).toContain("./schemas/plan-metadata.schema");
    expect(consumerContent).not.toContain('"./plan-metadata.schema"');
    expect(consumerContent).not.toMatch(/plan-metadata\.schema[^'"\s]*\.schema/);
  }, 60000);
});
