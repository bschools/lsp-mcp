import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSourceWatcher, type SourceWatcher } from "../../src/lsp/watcher.js";

type Event = { kind: "change" | "add" | "unlink"; filePath: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait until `predicate(events)` holds or `timeout` elapses (deterministic-ish
// poll over a real chokidar watcher — events are async but bounded).
async function waitFor(
  events: Event[],
  predicate: (e: Event[]) => boolean,
  timeout = 4000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(events)) return;
    await sleep(50);
  }
}

describe("createSourceWatcher — event contract", () => {
  let dir: string;
  let watcher: SourceWatcher;
  let events: Event[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "swatch-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    events = [];
    watcher = createSourceWatcher(dir, {
      debounceMs: 80,
      onChange: (filePath) => {
        events.push({ kind: "change", filePath });
      },
      onAdd: (filePath) => {
        events.push({ kind: "add", filePath });
      },
      onUnlink: (filePath) => {
        events.push({ kind: "unlink", filePath });
      },
    });
    // Let chokidar finish its (ignoreInitial) ready scan.
    await sleep(400);
  });

  afterEach(async () => {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fires onAdd for a newly created .ts file, then onChange on a subsequent edit", async () => {
    const f = path.join(dir, "src", "a.ts");
    fs.writeFileSync(f, "export const a = 1;\n");
    await waitFor(events, (e) => e.some((x) => x.kind === "add" && x.filePath === f));
    expect(events.some((x) => x.kind === "add" && x.filePath === f)).toBe(true);

    events.length = 0;
    fs.writeFileSync(f, "export const a = 2;\n");
    await waitFor(events, (e) => e.some((x) => x.kind === "change" && x.filePath === f));
    expect(events.some((x) => x.kind === "change" && x.filePath === f)).toBe(true);
  }, 15000);

  it("fires onUnlink when a tracked file is removed", async () => {
    const f = path.join(dir, "src", "b.ts");
    fs.writeFileSync(f, "export const b = 1;\n");
    await waitFor(events, (e) => e.some((x) => x.kind === "add" && x.filePath === f));

    events.length = 0;
    fs.rmSync(f);
    await waitFor(events, (e) => e.some((x) => x.kind === "unlink" && x.filePath === f));
    expect(events.some((x) => x.kind === "unlink" && x.filePath === f)).toBe(true);
  }, 15000);

  it("resolves an atomic-rename burst (unlink+recreate same path) by FINAL existence — no spurious onUnlink", async () => {
    const f = path.join(dir, "src", "c.ts");
    fs.writeFileSync(f, "export const c = 1;\n");
    await waitFor(events, (e) => e.some((x) => x.kind === "add" && x.filePath === f));

    events.length = 0;
    // Atomic-rename pattern: remove then immediately recreate the same path
    // within the debounce window. Coalesce-by-final-existence must NOT emit
    // onUnlink for a path that exists at flush time (the live-file case).
    fs.rmSync(f);
    fs.writeFileSync(f, "export const c = 2;\n");
    await sleep(1500);
    expect(events.some((x) => x.kind === "unlink" && x.filePath === f)).toBe(false);
    expect(events.some((x) => x.filePath === f && x.kind !== "unlink")).toBe(true);
  }, 15000);

  it("ignores skip-set directories (chokidar `ignored` traverses dirs, only skip-dirs are pruned)", async () => {
    const nm = path.join(dir, "node_modules", "pkg");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "index.ts"), "export const x = 1;\n");
    await sleep(1200);
    expect(events).toHaveLength(0);
  }, 15000);

  it("ignores non-watchable extensions while still descending the directory", async () => {
    fs.writeFileSync(path.join(dir, "src", "notes.txt"), "hello\n");
    fs.writeFileSync(path.join(dir, "src", "data.json"), "{}\n");
    await sleep(1000);
    expect(events).toHaveLength(0);

    // ...but a .ts sibling in the SAME directory is still observed (proves the
    // directory was descended, not ignored wholesale by the extension test).
    const ts = path.join(dir, "src", "real.ts");
    fs.writeFileSync(ts, "export const real = 1;\n");
    await waitFor(events, (e) => e.some((x) => x.kind === "add" && x.filePath === ts));
    expect(events.some((x) => x.kind === "add" && x.filePath === ts)).toBe(true);
  }, 15000);
});
