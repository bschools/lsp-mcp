import { z } from "zod";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { server } from "../server.js";
import * as url from "node:url";

const inputShape = {
  filePath: z.string().describe("Absolute path to the file to list symbols for"),
  name: z
    .string()
    .optional()
    .describe(
      "Return only symbols matching this name exactly, against either the bare name or the " +
        "parent-qualified name (`sendMessage` or `MessageService.sendMessage`). Omit to list all.",
    ),
};

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** LSP `DocumentSymbol` — hierarchical, returned when the server nests children. */
interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

/** LSP `SymbolInformation` — flat, with the parent carried as `containerName`. */
interface SymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: { uri: string; range: Range };
}

interface FlatSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  detail?: string;
  range: Range;
  selectionRange?: Range;
}

// LSP 3.17 SymbolKind. Numeric on the wire; callers want to filter on "is
// there a method called X here", so the name is what gets returned.
const SYMBOL_KINDS = [
  "File", "Module", "Namespace", "Package", "Class", "Method", "Property",
  "Field", "Constructor", "Enum", "Interface", "Function", "Variable",
  "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null",
  "EnumMember", "Struct", "Event", "Operator", "TypeParameter",
] as const;

function kindName(kind: number): string {
  // SymbolKind is 1-based.
  return SYMBOL_KINDS[kind - 1] ?? `Unknown(${kind})`;
}

function isHierarchical(
  symbols: DocumentSymbol[] | SymbolInformation[],
): symbols is DocumentSymbol[] {
  return symbols.length === 0 || !("location" in symbols[0]!);
}

/**
 * Flatten to one row per declaration, qualified by its parent chain, so
 * `MessageService.sendMessage` is directly greppable by a caller that only
 * knows a (path, symbolName) pair and has no position to offer.
 */
function flattenHierarchical(
  symbols: DocumentSymbol[],
  container: string,
  out: FlatSymbol[],
): void {
  for (const symbol of symbols) {
    const qualifiedName = container ? `${container}.${symbol.name}` : symbol.name;
    out.push({
      name: symbol.name,
      qualifiedName,
      kind: kindName(symbol.kind),
      ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
      range: symbol.range,
      selectionRange: symbol.selectionRange,
    });
    if (symbol.children?.length) {
      flattenHierarchical(symbol.children, qualifiedName, out);
    }
  }
}

function flattenFlat(symbols: SymbolInformation[]): FlatSymbol[] {
  return symbols.map((symbol) => ({
    name: symbol.name,
    qualifiedName: symbol.containerName
      ? `${symbol.containerName}.${symbol.name}`
      : symbol.name,
    kind: kindName(symbol.kind),
    range: symbol.location.range,
  }));
}

async function documentSymbols(input: {
  filePath: string;
  name?: string;
}): Promise<{
  filePath: string;
  totalSymbols: number;
  symbols: FlatSymbol[];
}> {
  const { filePath, name } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  const lifecycle = await getOrCreateClient(workspaceRoot);

  await lifecycle.ensureFile(filePath);
  const fileUri = url.pathToFileURL(filePath).href;

  // Deliberately NOT gated on waitForProjectLoad: documentSymbol is answered
  // per-file from the syntax server, so unlike references or rename it does
  // not depend on the project graph being loaded. Not paying that wait is the
  // whole reason this tool is cheap enough to ask about many files.
  const raw = ((await lifecycle.client.request("textDocument/documentSymbol", {
    textDocument: { uri: fileUri },
  })) ?? []) as DocumentSymbol[] | SymbolInformation[];

  const symbols: FlatSymbol[] = [];
  if (isHierarchical(raw)) {
    flattenHierarchical(raw, "", symbols);
  } else {
    symbols.push(...flattenFlat(raw));
  }

  // Filtering happens here rather than in the caller because the full list is
  // large enough to matter: a 700-line service file yields ~300 symbols and a
  // ~90 KB payload, since the server reports locals and object properties too.
  // `totalSymbols` keeps "no match" distinguishable from "empty file".
  const matched =
    name === undefined
      ? symbols
      : symbols.filter((s) => s.name === name || s.qualifiedName === name);

  return { filePath, totalSymbols: symbols.length, symbols: matched };
}

server.registerTool(
  "document_symbols",
  {
    description:
      "List symbols declared in a file (classes, methods, functions, types, variables) via LSP. " +
      "Takes no position — use it to answer whether a file declares a given name, which grep cannot " +
      "do because it cannot tell a declaration from a mention in a comment or string. Nested symbols " +
      "are returned flattened, each with a parent-qualified name such as `UserService.getName`. Pass " +
      "`name` to filter; large files can otherwise return several hundred symbols.",
    inputSchema: inputShape,
  },
  async (input) => {
    const result = await documentSymbols(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);
