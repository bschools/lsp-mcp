import { describe, expect, it, vi } from "vitest";
import {
  incompletePayload,
  runStableRequest,
  type StableRequestDeps,
} from "../../src/lsp/lifecycle.js";

function makeDeps(overrides: Partial<StableRequestDeps> = {}) {
  let clock = 0;
  const log = vi.fn<[string], void>(() => {});
  const deps: StableRequestDeps = {
    waitForProjectLoad: vi.fn(async () => true),
    getGeneration: () => 0,
    getActiveProjectLoads: () => 2,
    resync: vi.fn(async () => {}),
    log,
    now: () => (clock += 10),
    maxAttempts: 3,
    settleRetryMs: 0,
    projectLoadTimeoutMs: 60_000,
    settleMs: 500,
    ...overrides,
  };
  return { deps, log };
}

describe("runStableRequest", () => {
  it("returns project_loading on readiness timeout without invoking fn", async () => {
    const { deps } = makeDeps({ waitForProjectLoad: vi.fn(async () => false) });
    const fn = vi.fn(async () => "x");
    const result = await runStableRequest(deps, fn);
    expect(result).toMatchObject({ complete: false, code: "project_loading", retryable: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes the per-call projectLoadTimeoutMs to the readiness wait", async () => {
    const wait = vi.fn(async () => false);
    const { deps } = makeDeps({ waitForProjectLoad: wait, projectLoadTimeoutMs: 1234 });
    await runStableRequest(deps, async () => "x");
    expect(wait).toHaveBeenCalledWith(1234);
  });

  it("returns graph_changing when the generation moves on every attempt", async () => {
    let gen = 0;
    const { deps } = makeDeps({ getGeneration: () => gen });
    const fn = vi.fn(async () => {
      gen += 1;
      return "partial";
    });
    const result = await runStableRequest(deps, fn);
    expect(result).toMatchObject({ complete: false, code: "graph_changing", attempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("partial");
  });

  it("returns complete when the generation is stable on attempt 2", async () => {
    let gen = 0;
    const { deps, log } = makeDeps({ getGeneration: () => gen });
    let calls = 0;
    const result = await runStableRequest(deps, async () => {
      calls += 1;
      if (calls === 1) gen += 1;
      return `v${calls}`;
    });
    expect(result).toEqual({ complete: true, value: "v2" });
    expect(log).not.toHaveBeenCalled();
  });

  it("sets retryAfterMs to settleMs and logs exactly one telemetry line per incomplete", async () => {
    const { deps, log } = makeDeps({
      waitForProjectLoad: vi.fn(async () => false),
      settleMs: 750,
    });
    const result = await runStableRequest(deps, async () => "x");
    expect(result).toMatchObject({ complete: false, retryAfterMs: 750, activeProjectLoads: 2 });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    for (const field of ["project_loading", "elapsedMs=", "attempts=1", "activeProjectLoads=2", "retryAfterMs=750"]) {
      expect(line).toContain(field);
    }
  });

  it("resyncs and retries on Debug Failure, rethrowing on the last attempt", async () => {
    const { deps } = makeDeps();
    let calls = 0;
    const ok = await runStableRequest(deps, async () => {
      calls += 1;
      if (calls === 1) throw new Error("Debug Failure. False expression.");
      return "ok";
    });
    expect(ok).toEqual({ complete: true, value: "ok" });
    expect(deps.resync).toHaveBeenCalledTimes(1);

    const { deps: deps2 } = makeDeps();
    const always = vi.fn(async () => {
      throw new Error("Debug Failure. False expression.");
    });
    await expect(runStableRequest(deps2, always)).rejects.toThrow(/Debug Failure/);
    expect(always).toHaveBeenCalledTimes(3);
    expect(deps2.resync).toHaveBeenCalledTimes(2);
  });

  it("re-runs both requests of a two-request callback when the generation bumps between them", async () => {
    let gen = 0;
    const { deps } = makeDeps({ getGeneration: () => gen });
    const requests: string[] = [];
    let round = 0;
    const result = await runStableRequest(deps, async () => {
      round += 1;
      requests.push("codeAction");
      if (round === 1) gen += 1; // bump between the two requests
      requests.push("codeAction/resolve");
      return round;
    });
    expect(requests).toEqual([
      "codeAction",
      "codeAction/resolve",
      "codeAction",
      "codeAction/resolve",
    ]);
    expect(result).toEqual({ complete: true, value: 2 });
  });
});

describe("incompletePayload", () => {
  it("renders the wire shape with a retry hint", async () => {
    const { deps } = makeDeps({ waitForProjectLoad: vi.fn(async () => false) });
    const result = await runStableRequest(deps, async () => "x");
    if (result.complete) throw new Error("expected incomplete");
    const payload = incompletePayload(result);
    expect(payload).toMatchObject({
      ok: false,
      complete: false,
      code: "project_loading",
      retryable: true,
      retryAfterMs: 500,
      attempts: 1,
      activeProjectLoads: 2,
    });
    expect(payload.hint).toMatch(/500ms/);
    expect(payload.hint).toMatch(/three consecutive/);
  });
});
