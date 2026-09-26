import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, ChildProcessWithoutNullStreams } from "node:child_process";

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

type Position = { path: string; line: number; character: number };
type Classified = Position & { kind: string };
type Mention = { path: string; line: number; kind: string };

type RenameOutcome = {
  ok: boolean;
  applied?: boolean;
  verified?: boolean;
  code?: string;
  filesChanged: string[];
  verificationIncomplete?: { reason: string; candidateCount?: number; maxCandidates?: number };
  confirmedResiduals?: Classified[];
  unclassifiedCandidates?: Position[];
  homonyms?: Classified[];
  informationalMentions?: Mention[];
  lingeringReferences: string[];
};

const BASE_FILES: Record<string, string> = {
  ".gitignore": "node_modules\n",
  "package.json": JSON.stringify({ name: "rename-verify", private: true, type: "module" }, null, 2),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
      },
      include: ["src/**/*"],
    },
    null,
    2,
  ),
  "src/target.ts": ["export function oldName(): number {", "  return 1;", "}", ""].join("\n"),
  "src/consumer.ts": [
    'import { oldName } from "./target.js";',
    "",
    "export const value = oldName();",
    "",
  ].join("\n"),
};

// `export function ` is 16 characters: the declaration's name on line 0.
const TARGET = { file: "src/target.ts", line: 0, column: 16 };

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Many resolvable local `oldName` bindings: homonym candidates that take only the definition path. */
function bulkFiles(fileCount: number, usesPerFile: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < fileCount; i++) {
    const uses = Array.from({ length: usesPerFile }, () => "oldName").join(", ");
    files[`src/bulk/file${i}.ts`] = `const oldName = ${i};\n\nexport const values${i} = [${uses}];\n`;
  }
  return files;
}

describe("rename_symbol semantic verification", () => {
  let workspace: string | undefined;
  let client: McpTestClient | undefined;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  /**
   * Renames `oldName` -> `newName` at its declaration in a `git init`-ed
   * workspace. `files` are tracked (added to the index); `untracked` are
   * written afterwards and never added.
   */
  async function renameIn(options: {
    files?: Record<string, string>;
    untracked?: Record<string, string>;
    env?: Record<string, string>;
  }): Promise<RenameOutcome> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rename-verify-")));
    workspace = root;
    writeFiles(root, { ...BASE_FILES, ...options.files });
    fs.symlinkSync(path.join(LSP_MCP_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    writeFiles(root, options.untracked ?? {});

    client = new McpTestClient(binPath, root, { ...process.env, ...options.env });
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    client.notify("notifications/initialized", {});

    const resp = await client.request("tools/call", {
      name: "rename_symbol",
      arguments: {
        filePath: path.join(root, TARGET.file),
        line: TARGET.line,
        column: TARGET.column,
        newName: "newName",
      },
    });
    expect(resp.error).toBeUndefined();
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    const result = JSON.parse(text) as RenameOutcome;
    expect(result.applied, text).toBe(true);
    return result;
  }

  const abs = (rel: string): string => path.join(workspace!, rel);
  const pathsOf = (entries: Array<{ path: string }> | undefined): string[] =>
    (entries ?? []).map((e) => e.path);

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  it("reports a stale import specifier left inside an edited file as a confirmed residual", async () => {
    const result = await renameIn({
      files: {
        "src/stale.ts": "export const unrelated = 1;\n",
        "src/consumer.ts": [
          'import { oldName } from "./target.js";',
          'import { oldName as staleName } from "./stale.js";',
          "",
          "export const value = oldName();",
          "export const again = staleName();",
          "",
        ].join("\n"),
      },
    });

    expect(result.filesChanged).toContain(abs("src/consumer.ts"));
    expect(result).toMatchObject({ ok: false, verified: false, code: "rename_unverified" });
    expect(result.verificationIncomplete).toBeUndefined();
    expect(pathsOf(result.confirmedResiduals)).toEqual([abs("src/consumer.ts")]);
    // The raw text-match list skips edited files, so it cannot see this residual.
    expect(result.lingeringReferences).toEqual([]);
  }, 60000);

  it("reports an untracked spec consumer outside the tsconfig include set as a confirmed residual", async () => {
    const result = await renameIn({
      untracked: {
        "test/target.spec.ts": [
          'import { oldName } from "../src/target.js";',
          "",
          "export const fromSpec = oldName();",
          "",
        ].join("\n"),
      },
    });

    expect(result).toMatchObject({ ok: false, verified: false, code: "rename_unverified" });
    // Opening the spec for verification did not unsettle the graph.
    expect(result.verificationIncomplete).toBeUndefined();
    expect(pathsOf(result.confirmedResiduals)).toEqual([abs("test/target.spec.ts")]);
    expect(result.lingeringReferences).toContain(abs("test/target.spec.ts"));
  }, 60000);

  it("stays verified over a homonym, an alias, a string mention, a dynamic member, and a JS object key", async () => {
    const result = await renameIn({
      files: {
        // Broken before the rename, so the rename leaves it alone; afterwards
        // its old-named binding is an alias to the renamed declaration.
        "src/alias.ts": [
          'import { newName as oldName } from "./target.js";',
          "",
          "export const aliased = oldName();",
          "",
        ].join("\n"),
        "src/other.ts": ["export function oldName(): string {", '  return "other";', "}", ""].join("\n"),
        "src/labels.ts": 'export const label = "oldName";\n',
        "src/dynamic.ts": [
          "export function poke(x: unknown): unknown {",
          "  return (x as any).oldName;",
          "}",
          "",
        ].join("\n"),
        "src/legacy.js": "export const table = { oldName: 1 };\n",
      },
    });

    expect(result).toMatchObject({ ok: true, verified: true });
    expect(result.code).toBeUndefined();
    expect(result.verificationIncomplete).toBeUndefined();
    expect(result.confirmedResiduals).toEqual([]);
    expect(result.unclassifiedCandidates).toEqual([]);
    // The JS object key is its own declaration with no unbound-name diagnostic.
    expect(new Set(pathsOf(result.homonyms))).toEqual(new Set([abs("src/other.ts"), abs("src/legacy.js")]));
    expect(result.informationalMentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: abs("src/labels.ts"), kind: "string" }),
        expect.objectContaining({ path: abs("src/dynamic.ts"), kind: "untyped" }),
      ]),
    );
    // Raw text matches list every file, alias included; they do not decide verified.
    expect(new Set(result.lingeringReferences)).toEqual(
      new Set(["src/alias.ts", "src/other.ts", "src/labels.ts", "src/dynamic.ts", "src/legacy.js"].map(abs)),
    );
  }, 60000);

  it("classifies several hundred candidates across many files within the time budget", async () => {
    const startedAt = Date.now();
    const result = await renameIn({ files: bulkFiles(40, 10) });

    expect(result).toMatchObject({ ok: true, verified: true });
    expect(result.verificationIncomplete).toBeUndefined();
    expect(result.homonyms?.length).toBe(40 * 11);
    expect(result.lingeringReferences).toHaveLength(40);
    expect(Date.now() - startedAt).toBeLessThan(60000);
  }, 90000);

  it("returns candidate_budget, not a truncated success, when candidates exceed the cap", async () => {
    const result = await renameIn({
      files: bulkFiles(5, 10),
      env: { LSP_MCP_VERIFY_MAX_CANDIDATES: "20" },
    });

    expect(result).toMatchObject({
      ok: false,
      verified: false,
      code: "rename_unverified",
      verificationIncomplete: { reason: "candidate_budget", candidateCount: 55, maxCandidates: 20 },
    });
    expect(result.homonyms).toEqual([]);
    expect(result.unclassifiedCandidates).toHaveLength(55);
    expect(result.lingeringReferences).toHaveLength(5);
  }, 60000);

  it("returns time_budget when discovery exhausts the whole-pass budget", async () => {
    const result = await renameIn({ env: { LSP_MCP_VERIFY_BUDGET_MS: "0" } });

    expect(result).toMatchObject({
      ok: false,
      applied: true,
      verified: false,
      code: "rename_unverified",
      verificationIncomplete: { reason: "time_budget" },
    });
  }, 60000);
});
