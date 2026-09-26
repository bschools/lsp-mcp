import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { getOrCreateClient } from "../lsp/factory.js";
import { incompletePayload } from "../lsp/lifecycle.js";
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

type IncompleteRenameFile = ReturnType<typeof incompletePayload> & {
  filesChanged: string[];
  lingeringReferences: string[];
};

async function renameFile(input: {
  oldPath: string;
  newPath: string;
}): Promise<RenameFileResult | IncompleteRenameFile> {
  const { oldPath, newPath } = input;
  const workspaceRoot = detectWorkspaceRoot(oldPath);
  const lifecycle = await getOrCreateClient(workspaceRoot);

  const oldUri = url.pathToFileURL(oldPath).href;
  const newUri = url.pathToFileURL(newPath).href;

  // willRenameFiles — server returns edits for importers. Gated on a quiescent
  // project graph: importers in a project tsserver has not loaded yet are
  // simply absent from the edit, so their import specifiers break silently.
  const stable = await lifecycle.runStable(() =>
    lifecycle.client.request("workspace/willRenameFiles", {
      files: [{ oldUri, newUri }],
    }),
  );
  if (!stable.complete) {
    return { ...incompletePayload(stable), filesChanged: [], lingeringReferences: [] };
  }
  const edit = stable.value as WorkspaceEdit | null;

  const changed: string[] = [];
  if (edit) {
    changed.push(...applyWorkspaceEdit(edit));
    // Sync TS LS in-memory buffer with the disk edits. Without this, a subsequent
    // willRenameFiles call (e.g. renaming a paired .spec.ts) uses the stale
    // pre-edit content and produces mangled specifiers like "schemaa.schema".
    for (const changedFile of changed) {
      await lifecycle.didChange(changedFile);
    }
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
      "Rename a file and update import specifiers via LSP workspace/willRenameFiles." +
        " When the project graph is not settled it refuses before editing and returns complete:false with a retryable code (project_loading or graph_changing), retryAfterMs, and filesChanged:[]." +
        " lingeringReferences (tracked and untracked files) is an advisory text match, not a verification that every import was rewritten.",
    inputSchema: inputShape,
  },
  async (input) => {
    const result = await renameFile(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  },
);
