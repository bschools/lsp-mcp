import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
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
    description: "Get TypeScript diagnostics (errors, warnings) for a file via LSP.",
    inputSchema: inputShape,
  },
  async (input) => {
    const { filePath, timeoutMs } = input;
    const workspaceRoot = detectWorkspaceRoot(filePath);
    const lifecycle = await getOrCreateClient(workspaceRoot);

    await lifecycle.ensureFile(filePath);
    const fileUri = url.pathToFileURL(filePath).href;
    const diagnostics = await lifecycle.waitForDiagnostics(fileUri, timeoutMs);

    return {
      content: [{ type: "text", text: JSON.stringify({ filePath, diagnostics }, null, 2) }],
    };
  },
);
