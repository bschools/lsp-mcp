import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { getOrCreateClient } from "../lsp/factory.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { applyWorkspaceEdit, WorkspaceEdit } from "../workspace/edit-apply.js";
import { findLingeringReferences } from "../verify/lingering-refs.js";
import { server } from "../server.js";

const inputShape = {
  oldPath: z.string().describe("Absolute path to the existing file"),
  newPath: z.string().describe("Absolute path for the renamed file"),
};

interface RenameFileResult {
  ok: boolean;
  filesChanged: string[];
  lingeringReferences: string[];
}

async function renameFile(input: {
  oldPath: string;
  newPath: string;
}): Promise<RenameFileResult> {
  const { oldPath, newPath } = input;
  const workspaceRoot = detectWorkspaceRoot(oldPath);
  const lifecycle = await getOrCreateClient(workspaceRoot);

  const oldUri = url.pathToFileURL(oldPath).href;
  const newUri = url.pathToFileURL(newPath).href;

  // willRenameFiles — server returns edits for importers
  const edit = (await lifecycle.client.request("workspace/willRenameFiles", {
    files: [{ oldUri, newUri }],
  })) as WorkspaceEdit | null;

  const changed: string[] = [];
  if (edit) {
    changed.push(...applyWorkspaceEdit(edit));
  }

  // Actual FS rename
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
  changed.push(newPath);

  // didRenameFiles notification
  lifecycle.client.notify("workspace/didRenameFiles", {
    files: [{ oldUri, newUri }],
  });

  // Verify — word-boundary match catches identifier usages (e.g. re-exports)
  const oldBaseNoExt = path.basename(oldPath, path.extname(oldPath));
  const wordBoundaryRefs = findLingeringReferences({
    workspaceRoot,
    oldName: oldBaseNoExt,
    excludePaths: changed,
  });

  // Specifier-aware match catches quoted import paths:
  // "./user.service", "../path/user.service", "user.service" (no extension)
  const escapedBase = oldBaseNoExt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specifierPattern = new RegExp(
    `["'](\\.\\.?/[^'"]*|)${escapedBase}(?:\\.[tj]sx?)?["']`,
  );
  const specifierRefs = findLingeringReferences({
    workspaceRoot,
    oldName: oldBaseNoExt,
    excludePaths: changed,
    patternOverride: specifierPattern,
  });

  const lingering = [...new Set([...wordBoundaryRefs, ...specifierRefs])];

  return { ok: true, filesChanged: changed, lingeringReferences: lingering };
}

server.registerTool(
  "rename_file",
  {
    description:
      "Rename a file and update all import specifiers via LSP workspace/willRenameFiles.",
    inputSchema: inputShape,
  },
  async (input) => {
    const result = await renameFile(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);
