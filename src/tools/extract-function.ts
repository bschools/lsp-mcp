import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { applyWorkspaceEdit, WorkspaceEdit, TextEdit } from "../workspace/edit-apply.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string(),
  startLine: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  newName: z.string().min(1),
};

interface CodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
  command?: { command: string; arguments?: unknown[] };
}

type ExtractFunctionInput = {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newName: string;
};

type ExtractFunctionResult = {
  ok: boolean;
  filesChanged: string[];
  code?: string;
  hint?: string;
};

type PlaceholderInfo = {
  name: string;
  line: number;
  character: number;
};

async function extractFunction(input: ExtractFunctionInput): Promise<ExtractFunctionResult> {
  const { filePath, startLine, startColumn, endLine, endColumn, newName } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  const lifecycle = await getOrCreateClient(workspaceRoot);
  await lifecycle.ensureFile(filePath);

  const fileUri = url.pathToFileURL(filePath).href;
  const range = {
    start: { line: startLine, character: startColumn },
    end: { line: endLine, character: endColumn },
  };

  const actions = (await lifecycle.client.request("textDocument/codeAction", {
    textDocument: { uri: fileUri },
    range,
    context: { diagnostics: [], only: ["refactor.extract"] },
  })) as CodeAction[] | null;

  if (!actions || actions.length === 0) {
    return { ok: false, filesChanged: [], code: "no_extract_action" };
  }

  const action = actions.find((a) => /extract/i.test(a.title)) ?? actions[0];

  if (action.command) {
    return { ok: false, filesChanged: [], code: "command_execution_unsupported" };
  }
  if (!action.edit) {
    return { ok: false, filesChanged: [], code: "no_edit" };
  }

  // Derive placeholder position before applying edits (coords are pre-edit)
  const placeholder = derivePlaceholder(action.edit, fileUri, startLine);
  const changed = applyWorkspaceEdit(action.edit);
  for (const f of changed) {
    await lifecycle.didChange(f);
  }

  if (placeholder && placeholder.name !== newName) {
    let renameEdit: WorkspaceEdit | null = null;
    try {
      renameEdit = await lifecycle.client.request<WorkspaceEdit | null>(
        "textDocument/rename",
        {
          textDocument: { uri: fileUri },
          position: { line: placeholder.line, character: placeholder.character },
          newName,
        },
      );
    } catch {
      // Rename failed — report as hint, extraction still succeeded
    }

    if (renameEdit) {
      changed.push(...applyWorkspaceEdit(renameEdit));
    } else {
      return {
        ok: true,
        filesChanged: changed,
        hint: `extracted as '${placeholder.name}'; rename to '${newName}' failed — LSP declined rename`,
      };
    }
  }

  return { ok: true, filesChanged: changed };
}

function derivePlaceholder(
  edit: WorkspaceEdit,
  fileUri: string,
  selectionLine: number,
): PlaceholderInfo | undefined {
  const fileEdits: TextEdit[] = [];
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change.textDocument.uri === fileUri) {
        fileEdits.push(...change.edits);
      }
    }
  } else if (edit.changes) {
    fileEdits.push(...(edit.changes[fileUri] ?? []));
  }

  // Find the replacement edit — the one whose range contains the selection start
  const replacement =
    fileEdits.find(
      (e) =>
        e.range.start.line === selectionLine ||
        (e.range.start.line <= selectionLine && e.range.end.line >= selectionLine),
    ) ?? fileEdits[0];

  if (!replacement) return undefined;

  // First identifier followed by '(' is the extracted function call
  const match = replacement.newText.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (!match) return undefined;
  const name = match[1];

  // Compute position of placeholder within the newText (call-site anchor)
  const offset = replacement.newText.indexOf(name);
  const before = replacement.newText.slice(0, offset);
  const nlCount = (before.match(/\n/g) ?? []).length;
  const character =
    nlCount === 0
      ? replacement.range.start.character + offset
      : offset - before.lastIndexOf("\n") - 1;

  return { name, line: replacement.range.start.line + nlCount, character };
}

server.registerTool(
  "extract_function",
  {
    description:
      "Extract a code range into a new function via LSP codeAction (refactor.extract). Experimental.",
    inputSchema: inputShape,
  },
  async (input) => {
    try {
      const result = await extractFunction(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : err,
            }),
          },
        ],
        isError: true,
      };
    }
  },
);
