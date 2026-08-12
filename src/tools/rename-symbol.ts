import { z } from "zod";
import * as fs from "node:fs";
import { evictClient, getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { applyWorkspaceEdit, WorkspaceEdit } from "../workspace/edit-apply.js";
import { findLingeringReferences } from "../verify/lingering-refs.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string().describe("Absolute path to the file containing the symbol"),
  line: z.number().int().nonnegative().describe("0-indexed line number"),
  column: z.number().int().nonnegative().describe("0-indexed column number"),
  newName: z.string().min(1).describe("New symbol name"),
};

interface RenameResult {
  ok: boolean;
  filesChanged: string[];
  lingeringReferences: string[];
  oldName?: string;
  retried?: boolean;
  code?: string;
  hint?: string;
}

async function renameSymbol(input: {
  filePath: string;
  line: number;
  column: number;
  newName: string;
}): Promise<RenameResult> {
  const { filePath, line, column, newName } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  let lifecycle = await getOrCreateClient(workspaceRoot);

  await lifecycle.ensureFile(filePath);
  const fileUri = url.pathToFileURL(filePath).href;
  const position = { line, character: column };

  // Pre-check: prepareRename
  let oldName: string | undefined;
  try {
    const prepare = (await lifecycle.client.request("textDocument/prepareRename", {
      textDocument: { uri: fileUri },
      position,
    })) as { placeholder?: string; range?: unknown } | null;

    if (prepare === null) {
      return {
        ok: false,
        filesChanged: [],
        lingeringReferences: [],
        code: "not_renameable",
        hint: "LSP server rejected rename at this position",
      };
    }
    if (prepare && "placeholder" in prepare && prepare.placeholder) {
      oldName = prepare.placeholder;
    }
  } catch (err) {
    // Some servers don't implement prepareRename; continue anyway
    const code = (err as { code?: number })?.code;
    if (code !== -32601 && code !== -32602) {
      // Re-throw structured errors other than "method not found" / "invalid params"
      throw err;
    }
  }

  // prepareRename not supported or returned no placeholder — derive from file content
  // so verification pass never silently no-ops
  if (!oldName) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const targetLine = content.split("\n")[line] ?? "";
      const before = targetLine.slice(0, column);
      const after = targetLine.slice(column);
      const wordBefore = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(before)?.[1] ?? "";
      const wordAfter = /^([A-Za-z0-9_$]*)/.exec(after)?.[0] ?? "";
      const derived = wordBefore + wordAfter;
      if (derived) oldName = derived;
    } catch {
      // Proceed without oldName; verification skips
    }
  }

  // Perform rename, with Debug-Failure retry
  // Gated on a quiescent project graph — a rename computed mid-load rewrites
  // only the call sites tsserver happens to know about, leaving the rest
  // dangling. See the project-load readiness block in lsp/lifecycle.ts.
  const performRename = async (): Promise<WorkspaceEdit | null> => {
    return (await lifecycle.runStable(() =>
      lifecycle.client.request("textDocument/rename", {
        textDocument: { uri: fileUri },
        position,
        newName,
      }),
      filePath,
    )) as WorkspaceEdit | null;
  };

  let edit: WorkspaceEdit | null;
  let retried = false;

  try {
    edit = await performRename();
  } catch (err) {
    const message = (err as { message?: string })?.message ?? "";
    if (/Debug Failure/i.test(message)) {
      retried = true;
      await evictClient(workspaceRoot);
      lifecycle = await getOrCreateClient(workspaceRoot);
      await lifecycle.ensureFile(filePath);
      try {
        edit = await performRename();
      } catch {
        return {
          ok: false,
          filesChanged: [],
          lingeringReferences: [],
          oldName,
          retried: true,
          code: "lsp_debug_failure",
          hint: "fall back to manual edits",
        };
      }
    } else {
      throw err;
    }
  }

  if (!edit) {
    return {
      ok: false,
      filesChanged: [],
      lingeringReferences: [],
      oldName,
      retried,
      code: "no_edits",
      hint: "LSP returned null WorkspaceEdit",
    };
  }

  const filesChanged = applyWorkspaceEdit(edit);
  for (const f of filesChanged) {
    await lifecycle.didChange(f);
  }

  // Verification pass
  const lingeringReferences = oldName
    ? findLingeringReferences({
        workspaceRoot,
        oldName,
        excludePaths: filesChanged,
      })
    : [];

  return {
    ok: true,
    filesChanged,
    lingeringReferences,
    oldName,
    retried,
  };
}

server.registerTool(
  "rename_symbol",
  {
    description:
      "Rename a symbol project-wide via LSP. Applies WorkspaceEdit to filesystem and verifies no lingering references remain.",
    inputSchema: inputShape,
  },
  async (input) => {
    try {
      const result = await renameSymbol(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    } catch (err) {
      const payload = {
        ok: false,
        error: err instanceof Error ? err.message : err,
        code: (err as { code?: unknown })?.code,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  },
);
