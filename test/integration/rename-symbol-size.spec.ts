import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, ChildProcessWithoutNullStreams } from "node:child_process";

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

/** Claude Code's default MCP tool output limit, in tokens. */
const MCP_OUTPUT_TOKEN_LIMIT = 25_000;
/** Conservative characters-per-token ratio for JSON with long paths. */
const CHARS_PER_TOKEN = 3;
const MAX_RESPONSE_CHARS = MCP_OUTPUT_TOKEN_LIMIT * CHARS_PER_TOKEN;

/** Nested directory that pads absolute paths to PersonaMind-like lengths. */
const PAD_DIR = "libs/feature-packages/personamind-like-nested-module-directory";
const MIN_PATH_LENGTH = 70;

type FileCount = { path: string; count: number };
type FileKinds = FileCount & { kinds: string[] };

type RenameOutcome = {
  ok: boolean;
  applied?: boolean;
  verified?: boolean;
  code?: string;
  verificationIncomplete?: { reason: string };
  unclassifiedCandidates?: FileCount[];
  homonyms?: FileKinds[];
  informationalMentions?: FileKinds[];
};

const BASE_FILES: Record<string, string> = {
  ".gitignore": "node_modules\n",
  "package.json": JSON.stringify({ name: "rename-size", private: true, type: "module" }, null, 2),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
      },
      include: ["src/**/*", "libs/**/*"],
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

/** A local `oldName` binding used `occurrences - 1` times: homonym candidates only. */
function homonymFile(i: number, occurrences: number): string {
  const uses = Array.from({ length: occurrences - 1 }, () => "oldName").join(", ");
  return `const oldName = ${i};\n\nexport const values${i} = [${uses}];\n`;
}

const MENTION_LINES = [
  "// oldName first note",
  "// oldName second note",
  'export const label = "oldName";',
  "export const quoted = 'oldName';",
  "export const templated = `oldName`;",
  "/* oldName block note */",
  "// oldName seventh note",
];

/** One string, template, or comment mention of `oldName` per line. */
function mentionFile(mentions: number): string {
  return MENTION_LINES.slice(0, mentions).join("\n") + "\n";
}

/**
 * Tier-scale fixture, matching the measured per-field file counts: 614
 * text-match files before the rename; 55 source files hold 476 identifier
 * occurrences unrelated to the renamed symbol; 1,016 string, template, and
 * comment mentions spread over 164 source files; the rest are non-source.
 */
function tierScaleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  // 36 * 9 + 19 * 8 = 476 identifier occurrences in 55 files.
  for (let i = 0; i < 55; i++) {
    files[`${PAD_DIR}/homonyms/homonym-module-${i}.ts`] = homonymFile(i, i < 36 ? 9 : 8);
  }
  // 32 * 7 + 132 * 6 = 1,016 mentions in 164 files.
  for (let i = 0; i < 164; i++) {
    files[`${PAD_DIR}/mentions/mention-module-${i}.ts`] = mentionFile(i < 32 ? 7 : 6);
  }
  // target.ts + consumer.ts + 55 + 164 + 393 = 614 text-match files.
  for (let i = 0; i < 393; i++) {
    files[`${PAD_DIR}/docs/notes-${i}.md`] = `The oldName helper is documented here (${i}).\n`;
  }
  return files;
}

/** More than VERIFY_MAX_CANDIDATES (1,000) identifier occurrences: 110 files of 10. */
function candidateBudgetFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 110; i++) {
    files[`${PAD_DIR}/bulk/bulk-module-${i}.ts`] = homonymFile(i, 10);
  }
  return files;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe("rename_symbol serialized response size", () => {
  let workspace: string | undefined;
  let client: McpTestClient | undefined;
  const binPath = path.resolve(__dirname, "../../dist/bin.js");

  /** Renames `oldName` -> `newName` and returns the parsed result with the response text length. */
  async function renameIn(
    label: string,
    files: Record<string, string>,
    env: Record<string, string> = {},
  ): Promise<{ result: RenameOutcome; chars: number }> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rename-size-")));
    workspace = root;
    writeFiles(root, { ...BASE_FILES, ...files });
    fs.symlinkSync(path.join(LSP_MCP_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    for (const rel of Object.keys(files)) {
      expect(path.join(root, rel).length).toBeGreaterThanOrEqual(MIN_PATH_LENGTH);
    }

    client = new McpTestClient(binPath, root, { ...process.env, ...env });
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
    const chars = text.length;
    console.log(
      `[rename_symbol size] ${label}: ${chars} chars, ~${Math.ceil(chars / CHARS_PER_TOKEN)} tokens ` +
        `(limit ${MAX_RESPONSE_CHARS} chars)`,
    );
    const result = JSON.parse(text) as RenameOutcome;
    expect(result.applied, text.slice(0, 2000)).toBe(true);
    return { result, chars };
  }

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  it("stays under the MCP output limit at tier scale", async () => {
    const { result, chars } = await renameIn("tier-scale", tierScaleFiles());

    expect(result.verificationIncomplete?.reason).not.toBe("candidate_budget");
    expect(result.homonyms).toHaveLength(55);
    expect(result.informationalMentions).toHaveLength(164);
    expect(chars).toBeLessThan(MAX_RESPONSE_CHARS);
  }, 180000);

  it("stays under the MCP output limit at the default candidate budget", async () => {
    const { result, chars } = await renameIn("candidate_budget", candidateBudgetFiles());

    expect(result.code).toBe("rename_unverified");
    expect(result.verificationIncomplete?.reason).toBe("candidate_budget");
    expect(chars).toBeLessThan(MAX_RESPONSE_CHARS);
  }, 180000);

  it("stays under the MCP output limit when the time budget interrupts classification", async () => {
    // The deadline is wall-clock and covers discovery, so the window that interrupts classification
    // shifts with machine speed. Step the budget up until some candidates are classified and some are not.
    let outcome: { result: RenameOutcome; chars: number } | undefined;
    for (const budgetMs of [3000, 3500, 4000, 4500]) {
      outcome = await renameIn("time_budget", tierScaleFiles(), {
        LSP_MCP_VERIFY_BUDGET_MS: String(budgetMs),
      });
      const classified = (outcome.result.homonyms?.length ?? 0) + (outcome.result.informationalMentions?.length ?? 0);
      if (outcome.result.verificationIncomplete?.reason === "time_budget" && classified > 0) break;
      await client?.close();
      client = undefined;
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
      workspace = undefined;
    }
    const { result, chars } = outcome!;

    expect(result).toMatchObject({ ok: false, code: "rename_unverified" });
    expect(result.verificationIncomplete?.reason).toBe("time_budget");
    expect((result.homonyms?.length ?? 0) + (result.informationalMentions?.length ?? 0)).toBeGreaterThan(0);
    expect(result.unclassifiedCandidates?.length ?? 0).toBeGreaterThan(0);
    expect(chars).toBeLessThan(MAX_RESPONSE_CHARS);
  }, 180000);
});
