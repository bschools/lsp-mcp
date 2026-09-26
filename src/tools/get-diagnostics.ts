import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { incompletePayload } from "../lsp/lifecycle.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string().describe("Absolute path to the TypeScript file"),
  timeoutMs: z.number().int().nonnegative().optional().describe("Max ms to wait for diagnostics (default: 5000)"),
};

server.registerTool(
  "get_diagnostics",
  {
    description:
      "Get TypeScript diagnostics (errors, warnings) for a file via LSP." +
      " When the project graph is not settled it returns complete:false with a retryable code (project_loading or graph_changing) and retryAfterMs instead of a partial answer." +
      " timeoutMs separately bounds the wait for the diagnostic notification; an empty list after that wait is not proof of zero diagnostics.",
    inputSchema: inputShape,
  },
  async (input) => {
    const { filePath, timeoutMs } = input;
    const workspaceRoot = detectWorkspaceRoot(filePath);
    const lifecycle = await getOrCreateClient(workspaceRoot);

    await lifecycle.ensureFile(filePath);
    const fileUri = url.pathToFileURL(filePath).href;
    // Semantic diagnostics computed mid-load report phantom "Cannot find
    // module" errors for every dependency in a project that has not loaded.
    // runStable (not a bare waitForProjectLoad) so a load that begins just
    // after the settle window opens re-runs the collection instead of
    // returning the phantom set.
    //
    // Evicting the cached entry first is what makes the retry mean anything:
    // waitForDiagnostics reads diagnosticsByUri and returns the moment it
    // finds a non-empty entry, so a retry over a live cache hands back the
    // same phantom set it was retrying to escape. Dropping the entry forces
    // the wait to block on a fresh publish from the now-loaded project.
    const stable = await lifecycle.runStable(() => {
      lifecycle.diagnosticsByUri.delete(fileUri);
      return lifecycle.waitForDiagnostics(fileUri, timeoutMs);
    }, { resyncPath: filePath });
    if (!stable.complete) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(incompletePayload(stable), null, 2) }],
        isError: true,
      };
    }
    const diagnostics = stable.value;

    return {
      content: [{ type: "text", text: JSON.stringify({ filePath, diagnostics }, null, 2) }],
    };
  },
);
