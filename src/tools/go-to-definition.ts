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

interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface DefinitionLocation {
  path: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

server.registerTool(
  "go_to_definition",
  {
    description: "Jump to the definition of a symbol at a position via LSP.",
    inputSchema: inputShape,
  },
  async (input) => {
    const { filePath, line, column } = input;
    const workspaceRoot = detectWorkspaceRoot(filePath);
    const lifecycle = await getOrCreateClient(workspaceRoot);

    await lifecycle.ensureFile(filePath);
    const fileUri = url.pathToFileURL(filePath).href;

    const raw = (await lifecycle.client.request("textDocument/definition", {
      textDocument: { uri: fileUri },
      position: { line, character: column },
    })) as Location | Location[] | null;

    const locations: Location[] = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const definitions: DefinitionLocation[] = locations.map((loc) => ({
      path: url.fileURLToPath(loc.uri),
      range: loc.range,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ filePath, line, column, definitions }, null, 2) }],
    };
  },
);
