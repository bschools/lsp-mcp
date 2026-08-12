import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string().describe("Absolute path to the file containing the symbol"),
  line: z.number().int().nonnegative().describe("0-indexed line number"),
  column: z.number().int().nonnegative().describe("0-indexed column number"),
  includeDeclaration: z.boolean().optional().describe("Include the declaration site (default: true)"),
};

interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface FileReferences {
  path: string;
  ranges: Range[];
}

async function findReferences(input: {
  filePath: string;
  line: number;
  column: number;
  includeDeclaration?: boolean;
}): Promise<{ files: FileReferences[] }> {
  const { filePath, line, column, includeDeclaration = true } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  const lifecycle = await getOrCreateClient(workspaceRoot);

  await lifecycle.ensureFile(filePath);
  const fileUri = url.pathToFileURL(filePath).href;

  // Gated on a quiescent project graph: tsserver answers references from a
  // partially-loaded graph without saying so, which silently under-reports
  // callers. See the project-load readiness block in lsp/lifecycle.ts.
  const locations = ((await lifecycle.runStable(() =>
    lifecycle.client.request("textDocument/references", {
      textDocument: { uri: fileUri },
      position: { line, character: column },
      context: { includeDeclaration },
    }),
    filePath,
  )) ?? []) as Location[];

  const grouped = new Map<string, Range[]>();
  for (const loc of locations) {
    const p = url.fileURLToPath(loc.uri);
    const ranges = grouped.get(p) ?? [];
    ranges.push(loc.range);
    grouped.set(p, ranges);
  }

  return {
    files: Array.from(grouped.entries()).map(([p, ranges]) => ({ path: p, ranges })),
  };
}

server.registerTool(
  "find_references",
  {
    description:
      "Find all references to a symbol across the workspace via LSP. Returns files grouped with their reference ranges.",
    inputSchema: inputShape,
  },
  async (input) => {
    const result = await findReferences(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);
