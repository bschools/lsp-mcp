import { z } from "zod";
import * as fs from "node:fs";
import { evictClient, getOrCreateClient } from "../lsp/factory.js";
import { incompletePayload, numberEnv, type Diagnostic, type LspLifecycle } from "../lsp/lifecycle.js";
import { detectWorkspaceRoot } from "../workspace/detect.js";
import { applyWorkspaceEdit, TextEdit, WorkspaceEdit } from "../workspace/edit-apply.js";
import {
  findLingeringReferences,
  findResidualCandidates,
  type IdentifierCandidate,
  type InformationalMention,
} from "../verify/lingering-refs.js";
import {
  verifyResidualCandidates,
  VERIFY_BUDGET_MS,
  VERIFY_MAX_CANDIDATES,
  type ClassifiedCandidate,
  type DefinitionLocation,
  type RenamedDeclaration,
  type VerifyDeps,
  type VerifyIncomplete,
} from "../verify/residual-classify.js";
import { server } from "../server.js";
import * as path from "node:path";
import * as url from "node:url";

const inputShape = {
  filePath: z.string().describe("Absolute path to the file containing the symbol"),
  line: z.number().int().nonnegative().describe("0-indexed line number"),
  column: z.number().int().nonnegative().describe("0-indexed column number"),
  newName: z.string().min(1).describe("New symbol name"),
};

type UntypedMention = IdentifierCandidate & { kind: "untyped" };

type RenameResult = {
  ok: boolean;
  applied?: boolean;
  filesChanged: string[];
  verified?: boolean;
  verificationIncomplete?: VerifyIncomplete;
  confirmedResiduals?: ClassifiedCandidate[];
  unclassifiedCandidates?: IdentifierCandidate[];
  homonyms?: ClassifiedCandidate[];
  informationalMentions?: Array<InformationalMention | UntypedMention>;
  lingeringReferences: string[];
  oldName?: string;
  retried?: boolean;
  code?: string;
  hint?: string;
};

type IncompleteRename = ReturnType<typeof incompletePayload> & {
  filesChanged: string[];
  lingeringReferences: string[];
  oldName?: string;
  retried?: boolean;
};

async function renameSymbol(input: {
  filePath: string;
  line: number;
  column: number;
  newName: string;
}): Promise<RenameResult | IncompleteRename> {
  const { filePath, line, column, newName } = input;
  const workspaceRoot = detectWorkspaceRoot(filePath);
  let lifecycle = await getOrCreateClient(workspaceRoot);

  await lifecycle.ensureFile(filePath);
  const fileUri = url.pathToFileURL(filePath).href;
  const position = { line, character: column };

  // Pre-check: prepareRename
  let oldName: string | undefined;
  try {
    const prepare = (await lifecycle.client.request("textDocument/prepareRename", {
      textDocument: { uri: fileUri },
      position,
    })) as { placeholder?: string; range?: unknown } | null;

    if (prepare === null) {
      return {
        ok: false,
        filesChanged: [],
        lingeringReferences: [],
        code: "not_renameable",
        hint: "LSP server rejected rename at this position",
      };
    }
    if (prepare && "placeholder" in prepare && prepare.placeholder) {
      oldName = prepare.placeholder;
    }
  } catch (err) {
    // Some servers don't implement prepareRename; continue anyway
    const code = (err as { code?: number })?.code;
    if (code !== -32601 && code !== -32602) {
      // Re-throw structured errors other than "method not found" / "invalid params"
      throw err;
    }
  }

  // prepareRename not supported or returned no placeholder — derive from file content
  // so verification pass never silently no-ops
  if (!oldName) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const targetLine = content.split("\n")[line] ?? "";
      const before = targetLine.slice(0, column);
      const after = targetLine.slice(column);
      const wordBefore = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(before)?.[1] ?? "";
      const wordAfter = /^([A-Za-z0-9_$]*)/.exec(after)?.[0] ?? "";
      const derived = wordBefore + wordAfter;
      if (derived) oldName = derived;
    } catch {
      // Proceed without oldName; verification skips
    }
  }

  // Perform rename, with Debug-Failure retry
  // Gated on a quiescent project graph — a rename computed mid-load rewrites
  // only the call sites tsserver happens to know about, leaving the rest
  // dangling. See the project-load readiness block in lsp/lifecycle.ts.
  const performRename = async () => {
    return await lifecycle.runStable(() =>
      lifecycle.client.request("textDocument/rename", {
        textDocument: { uri: fileUri },
        position,
        newName,
      }),
      { resyncPath: filePath },
    );
  };

  let stable: Awaited<ReturnType<typeof performRename>>;
  let retried = false;

  try {
    stable = await performRename();
  } catch (err) {
    const message = (err as { message?: string })?.message ?? "";
    if (/Debug Failure/i.test(message)) {
      retried = true;
      await evictClient(workspaceRoot);
      lifecycle = await getOrCreateClient(workspaceRoot);
      await lifecycle.ensureFile(filePath);
      try {
        stable = await performRename();
      } catch {
        return {
          ok: false,
          filesChanged: [],
          lingeringReferences: [],
          oldName,
          retried: true,
          code: "lsp_debug_failure",
          hint: "fall back to manual edits",
        };
      }
    } else {
      throw err;
    }
  }

  if (!stable.complete) {
    return {
      ...incompletePayload(stable),
      filesChanged: [],
      lingeringReferences: [],
      oldName,
      retried,
    };
  }
  const edit = stable.value as WorkspaceEdit | null;

  if (!edit) {
    return {
      ok: false,
      filesChanged: [],
      lingeringReferences: [],
      oldName,
      retried,
      code: "no_edits",
      hint: "LSP returned null WorkspaceEdit",
    };
  }

  const filesChanged = applyWorkspaceEdit(edit);
  for (const f of filesChanged) {
    await lifecycle.didChange(f);
  }

  const applied = { applied: true, filesChanged, oldName, retried };
  if (!oldName) {
    return {
      ...applied,
      ok: false,
      verified: false,
      lingeringReferences: [],
      code: "rename_unverified",
      hint:
        `The old name could not be determined, so the rename was not verified. ` +
        `The edits in filesChanged are already on disk; review or revert them before retrying.`,
    };
  }

  // Raw text-match list; informational only, never decides verified/ok.
  const lingeringReferences = findLingeringReferences({
    workspaceRoot,
    oldName,
    excludePaths: filesChanged,
  });
  const { identifierCandidates, informationalMentions } = findResidualCandidates({ workspaceRoot, oldName });

  let verification: Awaited<ReturnType<typeof verifyResidualCandidates>>;
  try {
    const budgetMs = numberEnv("LSP_MCP_VERIFY_BUDGET_MS", VERIFY_BUDGET_MS);
    const maxCandidates = numberEnv("LSP_MCP_VERIFY_MAX_CANDIDATES", VERIFY_MAX_CANDIDATES);
    verification = await verifyResidualCandidates({
      candidates: identifierCandidates,
      renamedDeclaration: renamedDeclarationAt(edit, filePath, position),
      deps: verifyDeps(lifecycle),
      budget: { deadlineMs: Date.now() + budgetMs, maxCandidates },
    });
  } catch (err) {
    return {
      ...applied,
      ok: false,
      verified: false,
      unclassifiedCandidates: identifierCandidates,
      informationalMentions,
      lingeringReferences,
      code: "rename_unverified",
      hint:
        `Verification failed with an error (${err instanceof Error ? err.message : String(err)}). ` +
        `The edits in filesChanged are already on disk; review or revert them before retrying.`,
    };
  }

  const position0 = (c: ClassifiedCandidate): IdentifierCandidate => ({
    path: c.path,
    line: c.line,
    character: c.character,
  });
  const ofKind = (kind: ClassifiedCandidate["kind"]) =>
    verification.classified.filter((c) => c.kind === kind);
  const confirmedResiduals = ofKind("unresolved");
  const unclassifiedCandidates = ofKind("unclassifiable").map(position0);
  const result: RenameResult = {
    ...applied,
    ok: verification.verified,
    verified: verification.verified,
    verificationIncomplete: verification.incomplete,
    confirmedResiduals,
    unclassifiedCandidates,
    homonyms: ofKind("homonym"),
    informationalMentions: [
      ...informationalMentions,
      ...ofKind("untyped").map((c) => ({ ...position0(c), kind: "untyped" as const })),
    ],
    lingeringReferences,
  };
  if (verification.verified) return result;

  const affected = [...new Set([...confirmedResiduals, ...unclassifiedCandidates].map((c) => c.path))];
  const incomplete = verification.incomplete;
  const reason = incomplete
    ? `Verification was not completed (${incomplete.reason}) rather than failed; ` +
      `candidates it did not reach are listed as unclassified. `
    : "";
  return {
    ...result,
    code: "rename_unverified",
    hint:
      reason +
      `Residual or unclassified references to "${oldName}" remain in: ${affected.join(", ")}. ` +
      `The edits in filesChanged are already on disk; review or revert them before retrying.`,
  };
}

/** The renamed declaration's position after the edit, from the edit at the original position. */
function renamedDeclarationAt(
  edit: WorkspaceEdit,
  filePath: string,
  position: { line: number; character: number },
): RenamedDeclaration {
  const target = path.resolve(filePath);
  const edits: TextEdit[] = [];
  for (const change of edit.documentChanges ?? []) {
    if (path.resolve(url.fileURLToPath(change.textDocument.uri)) === target) edits.push(...change.edits);
  }
  if (!edit.documentChanges) {
    for (const [uri, fileEdits] of Object.entries(edit.changes ?? {})) {
      if (path.resolve(url.fileURLToPath(uri)) === target) edits.push(...fileEdits);
    }
  }
  const at = edits.find((e) => rangeContains(e.range, position));
  if (!at) return { path: target, ...position };
  const start = at.range.start;
  let { line, character } = start;
  for (const e of edits) {
    const { end } = e.range;
    if (e === at || end.line > start.line || (end.line === start.line && end.character > start.character)) {
      continue;
    }
    const newLines = e.newText.split("\n");
    line += newLines.length - 1 - (end.line - e.range.start.line);
    if (end.line === start.line) {
      const endAfter = (newLines.length === 1 ? e.range.start.character : 0) + newLines[newLines.length - 1].length;
      character += endAfter - end.character;
    }
  }
  return { path: target, line, character };
}

function rangeContains(
  range: TextEdit["range"],
  pos: { line: number; character: number },
): boolean {
  const afterStart =
    pos.line > range.start.line || (pos.line === range.start.line && pos.character >= range.start.character);
  const beforeEnd =
    pos.line < range.end.line || (pos.line === range.end.line && pos.character <= range.end.character);
  return afterStart && beforeEnd;
}

type LspLocation = { uri: string; range: DefinitionLocation["range"] };
type LspLocationLink = {
  targetUri: string;
  targetRange: DefinitionLocation["range"];
  targetSelectionRange?: DefinitionLocation["range"];
};

function verifyDeps(lifecycle: LspLifecycle): VerifyDeps {
  const uriOf = (p: string) => url.pathToFileURL(p).href;
  return {
    isOpen: (p) => lifecycle.isOpen(p),
    // didChange re-sends the full text of an open file, so its diagnostics refresh.
    open: (p) => lifecycle.didChange(p),
    close: (p) => lifecycle.didClose(p),
    clearDiagnostics: (p) => {
      lifecycle.diagnosticsByUri.delete(uriOf(p));
    },
    runStable: (fn, options) => lifecycle.runStable(fn, options),
    definition: async (c) => {
      const raw = (await lifecycle.client.request("textDocument/definition", {
        textDocument: { uri: uriOf(c.path) },
        position: { line: c.line, character: c.character },
      })) as LspLocation | Array<LspLocation | LspLocationLink> | null;
      const locations = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      return locations.map((loc) =>
        "targetUri" in loc
          ? {
              path: path.resolve(url.fileURLToPath(loc.targetUri)),
              range: loc.targetSelectionRange ?? loc.targetRange,
            }
          : { path: path.resolve(url.fileURLToPath(loc.uri)), range: loc.range },
      );
    },
    diagnosticsFor: (p, timeoutMs) => freshDiagnostics(lifecycle, uriOf(p), timeoutMs),
    now: Date.now,
  };
}

// tsserver publishes a file's diagnostics in rounds (syntactic, then semantic);
// the first non-empty round may not carry the semantic errors yet, so keep the
// latest publish until the stream has been quiet for the settle window.
const DIAGNOSTICS_SETTLE_MS = 2500;

async function freshDiagnostics(
  lifecycle: LspLifecycle,
  uri: string,
  timeoutMs: number,
): Promise<Diagnostic[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest: Diagnostic[] | undefined;
  let changedAt = 0;
  while (Date.now() < deadline) {
    const current = lifecycle.diagnosticsByUri.get(uri);
    if (current !== latest) {
      latest = current;
      changedAt = Date.now();
    } else if (latest !== undefined && Date.now() - changedAt >= DIAGNOSTICS_SETTLE_MS) {
      return latest;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return latest;
}

server.registerTool(
  "rename_symbol",
  {
    description:
      "Rename a symbol project-wide via LSP. Applies the WorkspaceEdit to disk, then semantically verifies " +
      "the old name no longer resolves anywhere (bounded by LSP_MCP_VERIFY_BUDGET_MS / LSP_MCP_VERIFY_MAX_CANDIDATES). " +
      "applied:true with verified:false (code rename_unverified) means the edits are on disk but confirmedResiduals or " +
      "unclassifiedCandidates remain, or verificationIncomplete names the budget or readiness reason. " +
      "homonyms, informationalMentions, and the raw lingeringReferences list do not affect verified." +
      " When the project graph is not settled it refuses before editing and returns complete:false with a retryable code (project_loading or graph_changing), retryAfterMs, and filesChanged:[].",
    inputSchema: inputShape,
  },
  async (input) => {
    try {
      const result = await renameSymbol(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    } catch (err) {
      const payload = {
        ok: false,
        error: err instanceof Error ? err.message : err,
        code: (err as { code?: unknown })?.code,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  },
);
