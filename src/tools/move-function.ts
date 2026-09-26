import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { incompletePayload } from "../lsp/lifecycle.js";
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
  data?: unknown;
}

type MoveFunctionInput = {
  filePath: string;
  line: number;
  column: number;
  destinationFile: string;
};

type MoveFunctionResult =
  | {
      ok: boolean;
      filesChanged: string[];
      code?: string;
      hint?: string;
    }
  | (ReturnType<typeof incompletePayload> & { filesChanged: string[] });

type MoveComputation =
  | { kind: "no_action" }
  | { kind: "action"; action: CodeAction };

async function moveFunction(input: MoveFunctionInput): Promise<MoveFunctionResult> {
  const { filePath, line, column, destinationFile } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  const lifecycle = await getOrCreateClient(workspaceRoot);
  await lifecycle.ensureFile(filePath);

  const fileUri = url.pathToFileURL(filePath).href;
  const destinationUri = url.pathToFileURL(destinationFile).href;
  const range = {
    start: { line, character: column },
    end: { line, character: column },
  };

  // Gated on a quiescent project graph — the move rewrites importers, and
  // importers in an unloaded project are absent from the edit. See lifecycle.
  // The codeAction request and the resolve that computes the edit share one
  // callback, so a graph change between them invalidates both.
  const stable = await lifecycle.runStable<MoveComputation>(async () => {
    const actions = (await lifecycle.client.request("textDocument/codeAction", {
      textDocument: { uri: fileUri },
      range,
      context: { diagnostics: [], only: ["refactor.move"] },
    })) as CodeAction[] | null;

    if (!actions || actions.length === 0) return { kind: "no_action" };

    let action = actions[0];

    // Attempt codeAction/resolve with destination file (tsserver-language-server convention).
    // Requires codeActionProvider.resolveProvider; falls back gracefully if unsupported.
    if (!action.edit) {
      try {
        action = await lifecycle.client.request<CodeAction>("codeAction/resolve", {
          ...action,
          data: {
            interactiveRefactorArguments: { targetFile: destinationUri },
          },
        });
      } catch {
        // Server does not support codeAction/resolve — proceed without destination
      }
    }
    return { kind: "action", action };
  }, { resyncPath: filePath });

  if (!stable.complete) {
    return { ...incompletePayload(stable), filesChanged: [] };
  }
  if (stable.value.kind === "no_action") {
    return { ok: false, filesChanged: [], code: "no_move_action" };
  }
  const action = stable.value.action;

  if (!action.edit) {
    return {
      ok: false,
      filesChanged: [],
      code: "destination_unsupported",
      hint: "tsserver-language-server does not honor interactiveRefactorArguments via standard LSP",
    };
  }

  const changed = applyWorkspaceEdit(action.edit);
  for (const f of changed) {
    await lifecycle.didChange(f);
  }
  return { ok: true, filesChanged: changed };
}

server.registerTool(
  "move_function",
  {
    description:
      "Move a function to a different file via LSP codeAction (refactor.move). Experimental — fidelity varies by language backend." +
        " When the project graph is not settled it refuses before editing and returns complete:false with a retryable code (project_loading or graph_changing), retryAfterMs, and filesChanged:[].",
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
