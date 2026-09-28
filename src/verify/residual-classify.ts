import type { Diagnostic, RunStableOptions, StableResult } from "../lsp/lifecycle.js";
import type { IdentifierCandidate } from "./lingering-refs.js";

export const VERIFY_BUDGET_MS = 30_000;
export const VERIFY_MAX_CANDIDATES = 1000;

/**
 * Diagnostics that mean "this name does not bind": unbound name, missing
 * export, or missing member on a typed receiver. Only these confirm a residual.
 */
const UNBOUND_CODES = new Set([2304, 2305, 2339, 2551, 2552, 2614, 2724]);

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type DefinitionLocation = { path: string; range: Range };

export type RenamedDeclaration = { path: string } & Position;

export type CandidateClass = "unresolved" | "untyped" | "unclassifiable" | "alias" | "homonym";

export type ClassifiedCandidate = IdentifierCandidate & {
  kind: CandidateClass;
  diagnostic?: { code: string | number; message: string };
  definition?: DefinitionLocation;
};

export type VerifyIncomplete =
  | { reason: "candidate_budget"; candidateCount: number; maxCandidates: number }
  | { reason: "time_budget" | "project_loading" | "graph_changing"; elapsedMs: number };

export type VerifyResult = {
  verified: boolean;
  classified: ClassifiedCandidate[];
  incomplete?: VerifyIncomplete;
};

export type VerifyDeps = {
  isOpen: (path: string) => boolean;
  /** didOpen, or a same-content didChange re-sync for an already-open file. */
  open: (path: string) => Promise<void>;
  close: (path: string) => Promise<void>;
  clearDiagnostics: (path: string) => void;
  runStable: <T>(
    fn: () => Promise<T>,
    options: Required<Pick<RunStableOptions, "projectLoadTimeoutMs">>,
  ) => Promise<StableResult<T>>;
  definition: (candidate: IdentifierCandidate) => Promise<DefinitionLocation[]>;
  /** Fresh post-edit diagnostics, or undefined when no notification arrived. */
  diagnosticsFor: (path: string, timeoutMs: number) => Promise<Diagnostic[] | undefined>;
  now: () => number;
};

export type VerifyBudget = { deadlineMs: number; maxCandidates: number };

export type VerifyResidualOptions = {
  candidates: IdentifierCandidate[];
  renamedDeclaration: RenamedDeclaration;
  deps: VerifyDeps;
  budget: VerifyBudget;
};

const TIMED_OUT = Symbol("timed_out");

/**
 * Post-edit semantic pass over residual identifier candidates. Each candidate
 * is classified from its definition and, when the definition is empty or is the
 * candidate itself, from the file's fresh diagnostics. A deadline or an
 * unsettled graph leaves unclassified candidates `unclassifiable` and marks
 * the result incomplete; it never reports verified on a truncated set.
 */
export async function verifyResidualCandidates(opts: VerifyResidualOptions): Promise<VerifyResult> {
  const { candidates, renamedDeclaration, deps, budget } = opts;
  const startedAt = deps.now();
  const remaining = (): number => budget.deadlineMs - deps.now();
  const kinds = new Map<IdentifierCandidate, ClassifiedCandidate>();
  const finish = (incomplete?: VerifyIncomplete): VerifyResult => {
    const classified = candidates.map(
      (c) => kinds.get(c) ?? { ...c, kind: "unclassifiable" as const },
    );
    const verified =
      !incomplete && !classified.some((c) => c.kind === "unresolved" || c.kind === "unclassifiable");
    return incomplete ? { verified, classified, incomplete } : { verified, classified };
  };
  const timeBudget = (): VerifyIncomplete => ({
    reason: "time_budget",
    elapsedMs: deps.now() - startedAt,
  });

  if (remaining() <= 0) return finish(timeBudget());
  if (candidates.length === 0) return finish();
  if (candidates.length > budget.maxCandidates) {
    return finish({
      reason: "candidate_budget",
      candidateCount: candidates.length,
      maxCandidates: budget.maxCandidates,
    });
  }

  const byFile = new Map<string, IdentifierCandidate[]>();
  for (const c of candidates) {
    const group = byFile.get(c.path);
    if (group) group.push(c);
    else byFile.set(c.path, [c]);
  }

  const openedByPass: string[] = [];
  try {
    for (const file of byFile.keys()) {
      // The server publishes a file's diagnostics only when they change, and
      // always once for a newly opened file. An open file's cached entry is its
      // current state; a closed file's entry is the empty set sent on close.
      if (!deps.isOpen(file)) {
        openedByPass.push(file);
        deps.clearDiagnostics(file);
      }
      await deps.open(file);
    }

    const stable = await deps.runStable(
      async () => {
        // Fresh per window: a generation change discards every earlier answer.
        const definitions = new Map<IdentifierCandidate, DefinitionLocation[]>();
        for (const group of byFile.values()) {
          if (remaining() <= 0) return { definitions, timedOut: true };
          const settled = await raceDeadline(
            Promise.all(
              group.map(async (c) => {
                definitions.set(c, await deps.definition(c));
              }),
            ),
            remaining(),
          );
          if (settled === TIMED_OUT) return { definitions, timedOut: true };
        }
        return { definitions, timedOut: false };
      },
      { projectLoadTimeoutMs: Math.max(0, remaining()) },
    );

    if (!stable.complete) {
      if (remaining() <= 0) return finish(timeBudget());
      return finish({ reason: stable.code, elapsedMs: deps.now() - startedAt });
    }

    const { definitions, timedOut } = stable.value;
    // Empty definitions, and self-definitions: an import of a name the module
    // no longer exports resolves to its own specifier, exactly like a genuine
    // local declaration. Only the file's diagnostics tell the two apart.
    const selfDefined = new Map<IdentifierCandidate, DefinitionLocation>();
    const diagnoseByFile = new Map<string, IdentifierCandidate[]>();
    const diagnose = (c: IdentifierCandidate): void => {
      const group = diagnoseByFile.get(c.path);
      if (group) group.push(c);
      else diagnoseByFile.set(c.path, [c]);
    };
    for (const [c, locations] of definitions) {
      if (locations.length === 0) {
        diagnose(c);
        continue;
      }
      const target = locations.find((loc) => containsDeclaration(loc, renamedDeclaration));
      if (target) {
        kinds.set(c, { ...c, kind: "alias", definition: target });
        continue;
      }
      const self = locations.find((loc) => loc.path === c.path && rangeContains(loc.range, c));
      if (self) {
        selfDefined.set(c, self);
        diagnose(c);
        continue;
      }
      kinds.set(c, { ...c, kind: "homonym", definition: locations[0] });
    }
    if (timedOut || remaining() <= 0) return finish(timeBudget());

    let diagnosticsTimedOut = false;
    await Promise.all(
      [...diagnoseByFile].map(async ([file, group]) => {
        const left = remaining();
        if (left <= 0) {
          diagnosticsTimedOut = true;
          return;
        }
        const diagnostics = await raceDeadline(deps.diagnosticsFor(file, left), left);
        if (diagnostics === TIMED_OUT) {
          diagnosticsTimedOut = true;
          return;
        }
        if (diagnostics === undefined) return;
        for (const c of group) {
          const match = diagnostics.find(
            (d) => UNBOUND_CODES.has(Number(d.code)) && rangeContains(d.range, c),
          );
          const self = selfDefined.get(c);
          if (match) {
            kinds.set(c, { ...c, kind: "unresolved", diagnostic: { code: match.code!, message: match.message } });
          } else if (self) {
            kinds.set(c, { ...c, kind: "homonym", definition: self });
          } else {
            kinds.set(c, { ...c, kind: "untyped" });
          }
        }
      }),
    );
    if (diagnosticsTimedOut || remaining() <= 0) return finish(timeBudget());
    return finish();
  } finally {
    for (const file of openedByPass) await deps.close(file);
  }
}

async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function containsDeclaration(loc: DefinitionLocation, decl: RenamedDeclaration): boolean {
  return loc.path === decl.path && rangeContains(loc.range, decl);
}

function rangeContains(range: Range, pos: Position): boolean {
  const afterStart =
    pos.line > range.start.line ||
    (pos.line === range.start.line && pos.character >= range.start.character);
  const beforeEnd =
    pos.line < range.end.line || (pos.line === range.end.line && pos.character <= range.end.character);
  return afterStart && beforeEnd;
}
