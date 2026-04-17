import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { applyWorkspaceEdit, WorkspaceEdit } from "../workspace/edit-apply.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  destinationFile: z.string(),
};

interface CodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
}

async function moveFunction(input: {
  filePath: string;
  line: number;
  column: number;
  destinationFile: string;
}): Promise<{ ok: boolean; filesChanged: string[]; code?: string }> {
  const { filePath, line, column } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  const lifecycle = await getOrCreateClient(workspaceRoot);
  await lifecycle.ensureFile(filePath);

  const fileUri = url.pathToFileURL(filePath).href;
  const range = {
    start: { line, character: column },
    end: { line, character: column },
  };

  const actions = (await lifecycle.client.request("textDocument/codeAction", {
    textDocument: { uri: fileUri },
    range,
    context: { diagnostics: [], only: ["refactor.move"] },
  })) as CodeAction[] | null;

  if (!actions || actions.length === 0) {
    return { ok: false, filesChanged: [], code: "no_move_action" };
  }

  const action = actions[0];
  let changed: string[] = [];
  if (action.edit) {
    changed = applyWorkspaceEdit(action.edit);
  }

  return { ok: true, filesChanged: changed };
}

server.registerTool(
  "move_function",
  {
    description:
      "Move a function to a different file via LSP codeAction (refactor.move). Experimental — fidelity varies by language backend.",
    inputSchema: inputShape,
  },
  async (input) => {
    try {
      const result = await moveFunction(input);
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
