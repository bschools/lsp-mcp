import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Regression corpus — Phase 4 cutover gate.
 *
 * Asserts parity between the old fork (`/home/benmar/lsp-mcp/dist/index.js`)
 * and the new clean-room server across historical PersonaMind rename targets.
 *
 * SKIP RULES:
 * - If OLD_LSP_MCP env var is unset → skip (corpus only runs when both servers
 *   available).
 * - If the old fork binary doesn't exist → skip with warning.
 *
 * Parity required on:
 * - filesChanged (same set of absolute paths, modulo ordering)
 * - lingeringReferences (new server may be stricter, but never looser)
 */

const OLD_LSP_MCP = process.env.OLD_LSP_MCP;
const NEW_LSP_MCP = path.resolve(__dirname, "../../dist/bin.js");
const FIXTURE_SRC = path.resolve(__dirname, "../fixtures/ts-sample");
const LSP_MCP_ROOT = path.resolve(__dirname, "../..");

// Only run when the user explicitly opts in by setting OLD_LSP_MCP to the
// old fork's bin path. This keeps CI green without requiring the old server.
const shouldSkip = !OLD_LSP_MCP || !fs.existsSync(OLD_LSP_MCP);

interface RenameCase {
  name: string;
  file: string;
  line: number;
  column: number;
  newName: string;
}

// PersonaMind rename targets — class, method, type alias, and function mix.
// At least two entries have spec-file consumers (UserService, AuthService).
const CORPUS: RenameCase[] = [
  // --- user.service.ts (has spec + consumer) ---
  {
    name: "UserService class rename",
    file: "src/user.service.ts",
    line: 0,
    column: 13,
    newName: "AccountService",
  },
  {
    name: "getName method rename",
    file: "src/user.service.ts",
    line: 1,
    column: 2,
    newName: "getDisplayName",
  },
  // --- consumer.ts ---
  {
    name: "makeService function rename",
    file: "src/consumer.ts",
    line: 2,
    column: 16,
    newName: "createService",
  },
  // --- auth.service.ts (has spec) ---
  {
    name: "IAuthProvider type alias rename",
    file: "src/auth.service.ts",
    line: 0,
    column: 12,
    newName: "ITokenValidator",
  },
  {
    name: "AuthService class rename",
    file: "src/auth.service.ts",
    line: 4,
    column: 13,
    newName: "TokenAuthService",
  },
  {
    name: "authenticate method rename",
    file: "src/auth.service.ts",
    line: 5,
    column: 2,
    newName: "verify",
  },
  {
    name: "logout method rename",
    file: "src/auth.service.ts",
    line: 9,
    column: 2,
    newName: "signOut",
  },
  // --- interfaces.ts ---
  {
    name: "IUserRepository type alias rename",
    file: "src/interfaces.ts",
    line: 0,
    column: 12,
    newName: "IUserStore",
  },
  // --- base.repository.ts ---
  {
    name: "BaseRepository class rename",
    file: "src/base.repository.ts",
    line: 2,
    column: 22,
    newName: "AbstractRepository",
  },
  {
    name: "findByIds method rename",
    file: "src/base.repository.ts",
    line: 6,
    column: 2,
    newName: "findManyByIds",
  },
  // --- user.repository.ts ---
  {
    name: "UserRepository class rename",
    file: "src/user.repository.ts",
    line: 2,
    column: 13,
    newName: "UserDataRepository",
  },
  // --- user-utils.ts ---
  {
    name: "formatUserName function rename",
    file: "src/user-utils.ts",
    line: 2,
    column: 16,
    newName: "formatDisplayName",
  },
];

interface ToolResult {
  ok: boolean;
  filesChanged: string[];
  lingeringReferences: string[];
}

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (v: unknown) => void>();

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
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  notify(method: string, params: unknown): void {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  async close(): Promise<void> {
    this.proc.kill();
    await new Promise((r) => setTimeout(r, 100));
  }
}

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

async function runRename(
  binPath: string,
  c: RenameCase,
): Promise<ToolResult> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-"));
  copyFixture(ws);
  const client = new McpClient(binPath, ws);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "corpus", version: "1" },
    });
    client.notify("notifications/initialized", {});

    const resp = (await client.request("tools/call", {
      name: "rename_symbol",
      arguments: {
        filePath: path.join(ws, c.file),
        line: c.line,
        column: c.column,
        newName: c.newName,
      },
    })) as { result?: { content: { text: string }[] } };

    const text = resp.result?.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as ToolResult;
    // Normalize paths to relative for parity comparison
    return {
      ok: parsed.ok,
      filesChanged: parsed.filesChanged.map((p) => path.relative(ws, p)).sort(),
      lingeringReferences: parsed.lingeringReferences
        .map((p) => path.relative(ws, p))
        .sort(),
    };
  } finally {
    await client.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

describe.skipIf(shouldSkip)("Phase 4 regression corpus", () => {
  it.each(CORPUS)("parity for: $name", async (c) => {
    const oldResult = await runRename(OLD_LSP_MCP!, c);
    const newResult = await runRename(NEW_LSP_MCP, c);

    expect(newResult.ok).toBe(oldResult.ok);
    expect(newResult.filesChanged).toEqual(oldResult.filesChanged);
    // New server may flag more lingering refs (stricter verification is OK,
    // looser is not). Assert: new is a superset of old.
    for (const ref of oldResult.lingeringReferences) {
      expect(newResult.lingeringReferences).toContain(ref);
    }
  }, 60000);
});

// Sanity smoke — runs without OLD_LSP_MCP; guards against bad line/col in corpus.
const newServerExists = fs.existsSync(NEW_LSP_MCP);
describe.skipIf(!newServerExists)("corpus sanity (new server only)", () => {
  it.each(CORPUS)("new server ok: $name", async (c) => {
    const result = await runRename(NEW_LSP_MCP, c);
    expect(result.ok).toBe(true);
  }, 60000);
});
