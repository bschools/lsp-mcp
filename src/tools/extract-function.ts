import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { applyWorkspaceEdit, WorkspaceEdit } from "../workspace/edit-apply.js";
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

async function extractFunction(input: {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newName: string;
}): Promise<{ ok: boolean; filesChanged: string[]; code?: string }> {
  const { filePath, startLine, startColumn, endLine, endColumn } = input;
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

  // Pick first extract action
  const action = actions.find((a) => /extract/i.test(a.title)) ?? actions[0];

  let changed: string[] = [];
  if (action.edit) {
    changed = applyWorkspaceEdit(action.edit);
  } else if (action.command) {
    // Some servers return a command that must be executed to produce the edit
    return {
      ok: false,
      filesChanged: [],
      code: "command_execution_unsupported",
    };
  }

  return { ok: true, filesChanged: changed };
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
