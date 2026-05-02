import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string().describe("Absolute path to the file"),
  line: z.number().int().nonnegative().describe("0-indexed line number"),
  column: z.number().int().nonnegative().describe("0-indexed column number"),
};

interface HoverResult {
  contents: string | { kind: string; value: string } | Array<{ language?: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

server.registerTool(
  "hover",
  {
    description: "Get hover information (type signature, documentation) for a symbol at a position via LSP.",
    inputSchema: inputShape,
  },
  async (input) => {
    const { filePath, line, column } = input;
    const workspaceRoot = detectWorkspaceRoot(filePath);
    const lifecycle = await getOrCreateClient(workspaceRoot);

    await lifecycle.ensureFile(filePath);
    const fileUri = url.pathToFileURL(filePath).href;

    const result = (await lifecycle.client.request("textDocument/hover", {
      textDocument: { uri: fileUri },
      position: { line, character: column },
    })) as HoverResult | null;

    return {
      content: [{ type: "text", text: JSON.stringify({ filePath, line, column, hover: result }, null, 2) }],
    };
  },
);
