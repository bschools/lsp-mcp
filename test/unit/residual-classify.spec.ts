import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStableRequest, type Diagnostic, type StableResult } from "../../src/lsp/lifecycle.js";
import type { IdentifierCandidate } from "../../src/verify/lingering-refs.js";
import {
  verifyResidualCandidates,
  VERIFY_BUDGET_MS,
  VERIFY_MAX_CANDIDATES,
  type DefinitionLocation,
  type RenamedDeclaration,
  type VerifyDeps,
} from "../../src/verify/residual-classify.js";

const DECL: RenamedDeclaration = { path: "/ws/decl.ts", line: 0, character: 13 };
const AT_DECL: DefinitionLocation = {
  path: "/ws/decl.ts",
  range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
};
const ELSEWHERE: DefinitionLocation = {
  path: "/ws/other.ts",
  range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
};

function cand(path: string, line: number, character: number): IdentifierCandidate {
  return { path, line, character };
}

function diag(code: number, line: number, start: number, end: number): Diagnostic {
  return {
    range: { start: { line, character: start }, end: { line, character: end } },
    code,
    message: `TS${code}`,
  };
}

type FakeOptions = {
  alreadyOpen?: string[];
  definition?: (c: IdentifierCandidate) => Promise<DefinitionLocation[]>;
  diagnostics?: Record<string, Diagnostic[] | undefined>;
  runStable?: VerifyDeps["runStable"];
};

function makeDeps(opts: FakeOptions = {}) {
  const events: string[] = [];
  const open = new Set(opts.alreadyOpen ?? []);
  const generation = { value: 0 };
  const deps: VerifyDeps = {
    isOpen: (p) => open.has(p),
    open: vi.fn(async (p: string) => {
      events.push(`open:${p}`);
      open.add(p);
    }),
    close: vi.fn(async (p: string) => {
      events.push(`close:${p}`);
      open.delete(p);
    }),
    clearDiagnostics: vi.fn((p: string) => {
      events.push(`clear:${p}`);
    }),
    runStable:
      opts.runStable ??
      (<T>(fn: () => Promise<T>, { projectLoadTimeoutMs }: { projectLoadTimeoutMs: number }) => {
        events.push("runStable");
        return runStableRequest(
          {
            waitForProjectLoad: async () => true,
            getGeneration: () => generation.value,
            getActiveProjectLoads: () => 0,
            resync: async () => {},
            log: () => {},
            now: Date.now,
            maxAttempts: 3,
            settleRetryMs: 0,
            projectLoadTimeoutMs,
            settleMs: 0,
          },
          fn,
        );
      }),
    definition: vi.fn(opts.definition ?? (async () => [ELSEWHERE])),
    diagnosticsFor: vi.fn(async (p: string) => opts.diagnostics?.[p]),
    now: () => Date.now(),
  };
  return { deps, events, generation };
}

function budget(ms = VERIFY_BUDGET_MS, maxCandidates = VERIFY_MAX_CANDIDATES) {
  return { deadlineMs: Date.now() + ms, maxCandidates };
}

function key(c: IdentifierCandidate): string {
  return `${c.path}:${c.line}:${c.character}`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyResidualCandidates classes", () => {
  it("classifies unresolved, untyped, unclassifiable, alias, and homonym", async () => {
    const unresolved = cand("/ws/a.ts", 3, 4);
    const untyped = cand("/ws/b.ts", 1, 10);
    const unclassifiable = cand("/ws/c.ts", 2, 0);
    const alias = cand("/ws/d.ts", 0, 9);
    const homonym = cand("/ws/e.ts", 5, 6);
    const defs = new Map([
      [key(alias), [AT_DECL]],
      [key(homonym), [ELSEWHERE]],
    ]);
    const { deps } = makeDeps({
      definition: async (c) => defs.get(key(c)) ?? [],
      diagnostics: {
        "/ws/a.ts": [diag(2304, 3, 4, 11)],
        "/ws/b.ts": [],
        "/ws/c.ts": undefined,
      },
    });

    const result = await verifyResidualCandidates({
      candidates: [unresolved, untyped, unclassifiable, alias, homonym],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.classified.map((c) => c.kind)).toEqual([
      "unresolved",
      "untyped",
      "unclassifiable",
      "alias",
      "homonym",
    ]);
    expect(result.classified[0].diagnostic).toEqual({ code: 2304, message: "TS2304" });
    expect(result.incomplete).toBeUndefined();
    expect(result.verified).toBe(false);
  });

  it("does not confirm a residual from a diagnostic at another position", async () => {
    const c = cand("/ws/a.ts", 3, 4);
    const { deps } = makeDeps({
      definition: async () => [],
      diagnostics: { "/ws/a.ts": [diag(2304, 7, 0, 7), diag(2304, 3, 12, 19)] },
    });

    const result = await verifyResidualCandidates({
      candidates: [c],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.classified[0].kind).toBe("untyped");
    expect(result.verified).toBe(true);
  });

  it("does not confirm a residual from a position-matched diagnostic outside the unbound-name codes", async () => {
    const c = cand("/ws/a.ts", 3, 4);
    const { deps } = makeDeps({
      definition: async () => [],
      diagnostics: { "/ws/a.ts": [diag(2322, 3, 4, 11)] },
    });

    const result = await verifyResidualCandidates({
      candidates: [c],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.classified[0].kind).toBe("untyped");
  });

  describe("self-defined candidates", () => {
    const c = cand("/ws/spec.ts", 0, 9);
    const SELF: DefinitionLocation = {
      path: "/ws/spec.ts",
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } },
    };

    async function classifySelf(diagnostics: Diagnostic[] | undefined) {
      const { deps } = makeDeps({
        definition: async () => [SELF],
        diagnostics: { "/ws/spec.ts": diagnostics },
      });
      return verifyResidualCandidates({ candidates: [c], renamedDeclaration: DECL, deps, budget: budget() });
    }

    it("is unresolved when a missing-export diagnostic covers it", async () => {
      const result = await classifySelf([diag(2305, 0, 9, 16)]);

      expect(result.classified[0]).toMatchObject({ kind: "unresolved", diagnostic: { code: 2305 } });
      expect(result.verified).toBe(false);
    });

    it("is a homonym when no unbound-name diagnostic covers it", async () => {
      const result = await classifySelf([]);

      expect(result.classified[0]).toMatchObject({ kind: "homonym", definition: SELF });
      expect(result.verified).toBe(true);
    });

    it("is unclassifiable when diagnostics never arrive", async () => {
      const result = await classifySelf(undefined);

      expect(result.classified[0].kind).toBe("unclassifiable");
      expect(result.verified).toBe(false);
    });
  });
});

describe("verifyResidualCandidates verified", () => {
  it("stays verified with only alias, homonym, and untyped candidates", async () => {
    const alias = cand("/ws/a.ts", 0, 0);
    const homonym = cand("/ws/a.ts", 1, 0);
    const untyped = cand("/ws/a.ts", 2, 0);
    const defs = new Map([
      [key(alias), [AT_DECL]],
      [key(homonym), [ELSEWHERE]],
    ]);
    const { deps } = makeDeps({
      definition: async (c) => defs.get(key(c)) ?? [],
      diagnostics: { "/ws/a.ts": [] },
    });

    const result = await verifyResidualCandidates({
      candidates: [alias, homonym, untyped],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result).toMatchObject({ verified: true });
    expect(result.classified.map((c) => c.kind)).toEqual(["alias", "homonym", "untyped"]);
  });

  it("is not verified when a single candidate is unresolved", async () => {
    const c = cand("/ws/a.ts", 3, 4);
    const { deps } = makeDeps({
      definition: async () => [],
      diagnostics: { "/ws/a.ts": [diag(2339, 3, 4, 11)] },
    });

    const result = await verifyResidualCandidates({
      candidates: [c],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.classified[0].kind).toBe("unresolved");
    expect(result.verified).toBe(false);
    expect(result.incomplete).toBeUndefined();
  });

  it("is not verified when a single candidate is unclassifiable", async () => {
    const { deps } = makeDeps({ definition: async () => [], diagnostics: {} });

    const result = await verifyResidualCandidates({
      candidates: [cand("/ws/a.ts", 0, 0)],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.verified).toBe(false);
    expect(result.incomplete).toBeUndefined();
  });

  it("is verified for an empty candidate set without opening files or running the window", async () => {
    const { deps, events } = makeDeps();

    const result = await verifyResidualCandidates({
      candidates: [],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result).toEqual({ verified: true, classified: [] });
    expect(events).toEqual([]);
  });
});

describe("verifyResidualCandidates stable window", () => {
  it("opens every file before one runStable call that resolves all candidates", async () => {
    const files = ["/ws/a.ts", "/ws/b.ts", "/ws/c.ts"];
    const candidates = files.flatMap((f) => [0, 1, 2, 3].map((line) => cand(f, line, 0)));
    const { deps, events } = makeDeps({ alreadyOpen: ["/ws/b.ts"] });

    const result = await verifyResidualCandidates({
      candidates,
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(events.filter((e) => e === "runStable")).toHaveLength(1);
    const windowAt = events.indexOf("runStable");
    for (const f of files) {
      expect(events.indexOf(`open:${f}`)).toBeLessThan(windowAt);
    }
    // Only newly opened files drop their cached diagnostics; an open file's
    // entry is its current published state.
    expect(events.filter((e) => e.startsWith("clear:"))).toEqual(["clear:/ws/a.ts", "clear:/ws/c.ts"]);
    expect(deps.definition).toHaveBeenCalledTimes(candidates.length);
    expect(result.verified).toBe(true);
  });

  it("re-runs the whole window when the generation changes mid-window", async () => {
    const candidates = [cand("/ws/a.ts", 0, 0), cand("/ws/a.ts", 1, 0), cand("/ws/b.ts", 0, 0)];
    let calls = 0;
    const { deps, events, generation } = makeDeps({
      definition: async () => {
        calls += 1;
        if (calls === 2) generation.value += 1;
        return [ELSEWHERE];
      },
    });

    const result = await verifyResidualCandidates({
      candidates,
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(events.filter((e) => e === "runStable")).toHaveLength(1);
    expect(deps.definition).toHaveBeenCalledTimes(candidates.length * 2);
    expect(result.verified).toBe(true);
  });

  it("returns graph_changing with every candidate unclassifiable when the graph never settles", async () => {
    const { deps, generation } = makeDeps({
      definition: async () => {
        generation.value += 1;
        return [ELSEWHERE];
      },
    });

    const result = await verifyResidualCandidates({
      candidates: [cand("/ws/a.ts", 0, 0)],
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.incomplete).toMatchObject({ reason: "graph_changing" });
    expect(result.classified[0].kind).toBe("unclassifiable");
    expect(result.verified).toBe(false);
  });
});

describe("verifyResidualCandidates budgets", () => {
  it("returns candidate_budget without opening anything past maxCandidates", async () => {
    const candidates = [0, 1, 2].map((line) => cand("/ws/a.ts", line, 0));
    const { deps, events } = makeDeps();

    const result = await verifyResidualCandidates({
      candidates,
      renamedDeclaration: DECL,
      deps,
      budget: budget(VERIFY_BUDGET_MS, 2),
    });

    expect(result.incomplete).toEqual({ reason: "candidate_budget", candidateCount: 3, maxCandidates: 2 });
    expect(result.verified).toBe(false);
    expect(result.classified.every((c) => c.kind === "unclassifiable")).toBe(true);
    expect(deps.open).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("returns time_budget when a slow resolver passes the deadline, leaving the rest unclassifiable", async () => {
    const fast = cand("/ws/a.ts", 0, 0);
    const slow = cand("/ws/b.ts", 0, 0);
    const { deps } = makeDeps({
      alreadyOpen: ["/ws/a.ts"],
      definition: (c) =>
        c.path === slow.path
          ? new Promise((resolve) => setTimeout(() => resolve([ELSEWHERE]), 60_000))
          : Promise.resolve([ELSEWHERE]),
    });

    const pending = verifyResidualCandidates({
      candidates: [fast, slow],
      renamedDeclaration: DECL,
      deps,
      budget: budget(1000),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.incomplete).toMatchObject({ reason: "time_budget" });
    expect(result.classified.map((c) => c.kind)).toEqual(["homonym", "unclassifiable"]);
    expect(result.verified).toBe(false);
    expect(vi.mocked(deps.close).mock.calls).toEqual([["/ws/b.ts"]]);
  });

  it("returns time_budget when the readiness wait passes the deadline", async () => {
    const runStable = async <T>(
      _fn: () => Promise<T>,
      { projectLoadTimeoutMs }: { projectLoadTimeoutMs: number },
    ): Promise<StableResult<T>> => {
      await new Promise((r) => setTimeout(r, projectLoadTimeoutMs));
      return {
        complete: false,
        code: "project_loading",
        retryable: true,
        retryAfterMs: 500,
        elapsedMs: projectLoadTimeoutMs,
        attempts: 1,
        activeProjectLoads: 1,
        message: "loading",
      };
    };
    const { deps } = makeDeps({ runStable });

    const pending = verifyResidualCandidates({
      candidates: [cand("/ws/a.ts", 0, 0)],
      renamedDeclaration: DECL,
      deps,
      budget: budget(2000),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.incomplete).toEqual({ reason: "time_budget", elapsedMs: 2000 });
    expect(result.classified[0].kind).toBe("unclassifiable");
    expect(deps.definition).not.toHaveBeenCalled();
    expect(vi.mocked(deps.close).mock.calls).toEqual([["/ws/a.ts"]]);
  });

  it("returns time_budget when diagnostics do not arrive before the deadline", async () => {
    const { deps } = makeDeps({ definition: async () => [] });
    deps.diagnosticsFor = vi.fn(() => new Promise<undefined>(() => {}));

    const pending = verifyResidualCandidates({
      candidates: [cand("/ws/a.ts", 0, 0)],
      renamedDeclaration: DECL,
      deps,
      budget: budget(500),
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result.incomplete).toMatchObject({ reason: "time_budget" });
    expect(result.classified[0].kind).toBe("unclassifiable");
  });

  it("finishes a 1000-candidate set with an instant resolver within the budget", async () => {
    vi.useRealTimers();
    const candidates = Array.from({ length: VERIFY_MAX_CANDIDATES }, (_, i) =>
      cand(`/ws/f${i % 20}.ts`, i, 0),
    );
    const { deps, events } = makeDeps();
    const startedAt = Date.now();

    const result = await verifyResidualCandidates({
      candidates,
      renamedDeclaration: DECL,
      deps,
      budget: budget(),
    });

    expect(result.incomplete).toBeUndefined();
    expect(result.verified).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(VERIFY_BUDGET_MS);
    expect(events.filter((e) => e === "runStable")).toHaveLength(1);
  });
});

describe("verifyResidualCandidates cleanup", () => {
  it("closes exactly the files the pass opened", async () => {
    const candidates = [cand("/ws/a.ts", 0, 0), cand("/ws/b.ts", 0, 0), cand("/ws/c.ts", 0, 0)];
    const { deps } = makeDeps({ alreadyOpen: ["/ws/b.ts"] });

    await verifyResidualCandidates({ candidates, renamedDeclaration: DECL, deps, budget: budget() });

    expect(vi.mocked(deps.open).mock.calls.map(([p]) => p)).toEqual(["/ws/a.ts", "/ws/b.ts", "/ws/c.ts"]);
    expect(vi.mocked(deps.close).mock.calls.map(([p]) => p)).toEqual(["/ws/a.ts", "/ws/c.ts"]);
  });

  it("closes the files it opened when the resolver throws", async () => {
    const candidates = [cand("/ws/a.ts", 0, 0), cand("/ws/b.ts", 0, 0)];
    const { deps } = makeDeps({
      alreadyOpen: ["/ws/a.ts"],
      definition: async () => {
        throw new Error("boom");
      },
    });

    await expect(
      verifyResidualCandidates({ candidates, renamedDeclaration: DECL, deps, budget: budget() }),
    ).rejects.toThrow("boom");

    expect(vi.mocked(deps.close).mock.calls.map(([p]) => p)).toEqual(["/ws/b.ts"]);
  });
});
