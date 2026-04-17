import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as os from "node:os";

export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{
    textDocument: { uri: string };
    edits: TextEdit[];
  }>;
}

function applyEditsToContent(content: string, edits: TextEdit[]): string {
  const lines = content.split("\n");

  // Sort edits in reverse order (bottom-to-top) to preserve offsets
  const sorted = [...edits].sort((a, b) => {
    if (b.range.start.line !== a.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sorted) {
    const { start, end } = edit.range;

    if (start.line === end.line) {
      const line = lines[start.line] ?? "";
      lines[start.line] =
        line.slice(0, start.character) + edit.newText + line.slice(end.character);
    } else {
      const startLine = lines[start.line] ?? "";
      const endLine = lines[end.line] ?? "";
      const newContent =
        startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
      lines.splice(start.line, end.line - start.line + 1, newContent);
    }
  }

  return lines.join("\n");
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.lsp-mcp-${os.hostname()}-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export function applyWorkspaceEdit(edit: WorkspaceEdit): string[] {
  const fileEdits = new Map<string, TextEdit[]>();

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      const filePath = url.fileURLToPath(change.textDocument.uri);
      const existing = fileEdits.get(filePath) ?? [];
      fileEdits.set(filePath, existing.concat(change.edits));
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const filePath = url.fileURLToPath(uri);
      const existing = fileEdits.get(filePath) ?? [];
      fileEdits.set(filePath, existing.concat(edits));
    }
  }

  const changed: string[] = [];

  for (const [filePath, edits] of fileEdits) {
    if (edits.length === 0) continue;
    const original = fs.readFileSync(filePath, "utf8");
    const updated = applyEditsToContent(original, edits);
    if (updated !== original) {
      atomicWrite(filePath, updated);
      changed.push(filePath);
    }
  }

  return changed;
}
