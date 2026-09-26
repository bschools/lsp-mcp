import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findLingeringReferences,
  findResidualCandidates,
  ResidualDiscoveryDeadlineExceeded,
} from "../../src/verify/lingering-refs.js";

let root: string;

function write(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lingering-refs-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("untracked sources", () => {
  it("finds an untracked .spec.ts consumer in both functions", () => {
    write("a.ts", "export const oldThing = 1;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: root });
    const spec = write("a.spec.ts", "import { oldThing } from './a';\nvoid oldThing;\n");

    const opts = { workspaceRoot: root, oldName: "oldThing" };
    expect(findLingeringReferences({ ...opts, excludePaths: [] })).toContain(spec);
    const { identifierCandidates } = findResidualCandidates(opts);
    expect(identifierCandidates.some((c) => c.path === spec)).toBe(true);
  });
});

describe("findResidualCandidates", () => {
  it("fails closed when the discovery deadline has expired", () => {
    expect(() =>
      findResidualCandidates({ workspaceRoot: root, oldName: "oldThing", deadlineMs: Date.now() - 1 }),
    ).toThrow(ResidualDiscoveryDeadlineExceeded);
  });

  it("finds identifiers beginning with a dollar sign", () => {
    const file = write("dollar.ts", "const $old = 1;\nvoid $old;\n");
    execFileSync("git", ["add", "."], { cwd: root });

    expect(findLingeringReferences({ workspaceRoot: root, oldName: "$old", excludePaths: [] })).toContain(file);
    expect(findResidualCandidates({ workspaceRoot: root, oldName: "$old" }).identifierCandidates).toEqual([
      { path: file, line: 0, character: 6 },
      { path: file, line: 1, character: 5 },
    ]);
  });

  it("examines source files larger than one megabyte", () => {
    const file = write("large.ts", `const oldThing = 1;\n/*${"x".repeat(1_000_030)}*/\n`);
    execFileSync("git", ["add", "."], { cwd: root });

    expect(findResidualCandidates({ workspaceRoot: root, oldName: "oldThing" }).identifierCandidates).toEqual([
      { path: file, line: 0, character: 6 },
    ]);

    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
    expect(findResidualCandidates({ workspaceRoot: root, oldName: "oldThing" }).identifierCandidates).toEqual([
      { path: file, line: 0, character: 6 },
    ]);
  });

  it("reports identifiers in edited files as candidates with positions", () => {
    const edited = write("edited.ts", "const x = 1;\nconsole.log(oldThing);\n");
    execFileSync("git", ["add", "."], { cwd: root });

    const { identifierCandidates } = findResidualCandidates({
      workspaceRoot: root,
      oldName: "oldThing",
    });
    expect(identifierCandidates).toEqual([{ path: edited, line: 1, character: 12 }]);
  });

  it("keeps an identifier after an apostrophe or backtick in JSX text as a candidate", () => {
    const file = write(
      "view.tsx",
      "export const a = <p>Don't {oldThing}</p>;\nexport const b = <p>`tick {oldThing}</p>;\n",
    );
    execFileSync("git", ["add", "."], { cwd: root });

    const { identifierCandidates, informationalMentions } = findResidualCandidates({
      workspaceRoot: root,
      oldName: "oldThing",
    });
    expect(identifierCandidates).toEqual([
      { path: file, line: 0, character: 27 },
      { path: file, line: 1, character: 27 },
    ]);
    expect(informationalMentions).toEqual([]);
  });

  it("treats string, template, and comment occurrences as informational only", () => {
    const file = write(
      "info.ts",
      [
        'const s = "oldThing";',
        "const t = `a ${1} oldThing`;",
        "// oldThing here",
        "/* x",
        "oldThing */",
        'const r = /"/; const n = 1 / 2;',
        "",
      ].join("\n"),
    );

    const res = findResidualCandidates({ workspaceRoot: root, oldName: "oldThing" });
    expect(res.identifierCandidates).toEqual([]);
    expect(res.informationalMentions).toEqual([
      { path: file, line: 0, kind: "string" },
      { path: file, line: 1, kind: "template" },
      { path: file, line: 2, kind: "comment" },
      { path: file, line: 4, kind: "comment" },
    ]);
  });

  it("keeps property names and other homonyms as candidates", () => {
    const file = write("homonym.ts", "const o = { oldThing: 1 };\nvoid o.oldThing;\n");

    const { identifierCandidates } = findResidualCandidates({
      workspaceRoot: root,
      oldName: "oldThing",
    });
    expect(identifierCandidates.map((c) => [c.path, c.line, c.character])).toEqual([
      [file, 0, 12],
      [file, 1, 7],
    ]);
  });

  it("ignores non-source text matches", () => {
    write("notes.md", "oldThing\n");
    const res = findResidualCandidates({ workspaceRoot: root, oldName: "oldThing" });
    expect(res).toEqual({ identifierCandidates: [], informationalMentions: [] });
  });
});
