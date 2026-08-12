import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverProjectRepresentatives,
  parseTsconfig,
} from "../../src/workspace/projects.js";

describe("parseTsconfig", () => {
  it("tolerates line comments, block comments and trailing commas", () => {
    const parsed = parseTsconfig(`{
      // solution style
      "files": [],
      /* referenced projects */
      "references": [
        { "path": "./tsconfig.libs.json" },
      ],
    }`);
    expect(parsed).toEqual({
      files: [],
      references: [{ path: "./tsconfig.libs.json" }],
    });
  });

  it("does not mistake a URL in a string for a line comment", () => {
    expect(parseTsconfig(`{ "extends": "https://example.com/base.json" }`)).toEqual({
      extends: "https://example.com/base.json",
    });
  });

  it("does not read a path glob as a block comment", () => {
    // Regression: `"@libs/*"` opens what a naive stripper calls a block
    // comment and `"**/*.spec.ts"` closes it, deleting everything between —
    // which silently turned every real tsconfig into a parse failure.
    expect(
      parseTsconfig(`{
        "compilerOptions": { "paths": { "@libs/*": ["libs/*"] } },
        "include": ["libs/**/*.ts"],
        "exclude": ["**/*.spec.ts"]
      }`),
    ).toEqual({
      compilerOptions: { paths: { "@libs/*": ["libs/*"] } },
      include: ["libs/**/*.ts"],
      exclude: ["**/*.spec.ts"],
    });
  });

  it("keeps a comma that lives inside a string value", () => {
    expect(parseTsconfig(`{ "a": ["x,", "y"] }`)).toEqual({ a: ["x,", "y"] });
  });

  it("returns null for unparseable input", () => {
    expect(parseTsconfig("{ not json")).toBeNull();
  });
});

describe("discoverProjectRepresentatives", () => {
  let root: string;

  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns one file per referenced project of a solution-style root", () => {
    // The shape that breaks naive warmup: root owns no files, three referenced
    // projects own everything. Opening N files from one project loads one
    // project, so references into the other two come back empty.
    write(
      "tsconfig.json",
      JSON.stringify({ files: [], references: [
        { path: "./tsconfig.libs.json" },
        { path: "./tsconfig.server.json" },
      ] }),
    );
    write("tsconfig.libs.json", JSON.stringify({ include: ["libs/**/*.ts"] }));
    write("tsconfig.server.json", JSON.stringify({ include: ["apps/server/**/*.ts"] }));
    write("libs/a/src/one.ts", "export const one = 1;\n");
    write("libs/b/src/two.ts", "export const two = 2;\n");
    write("apps/server/src/main.ts", "export const main = 3;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    // Membership, not length: which file inside libs/ is picked is an artifact
    // of walk order, not the property under test. The solution root itself
    // contributes nothing — `files: []` is a declared-and-empty surface.
    expect(reps.some((p) => p.startsWith(path.join("libs", "a")))).toBe(true);
    expect(reps).toContain(path.join("apps", "server", "src", "main.ts"));
  });

  it("covers a nested project the root never references", () => {
    write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.libs.json" }] }));
    write("tsconfig.libs.json", JSON.stringify({ include: ["libs/**/*.ts"] }));
    write("libs/one.ts", "export const one = 1;\n");
    write("apps/web/tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"] }));
    write("apps/web/src/app.ts", "export const app = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toContain(path.join("apps", "web", "src", "app.ts"));
  });

  it("does not descend into skipped directories when picking a representative", () => {
    write("tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"] }));
    write("src/node_modules/dep/index.ts", "export const dep = 1;\n");
    write("src/real.ts", "export const real = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toEqual([path.join("src", "real.ts")]);
  });

  it("inherits the file surface through extends", () => {
    // A leaf that declares neither files nor include: without following
    // extends, its roots collapse to the repo root and the representative can
    // come from a different project entirely, leaving this one unloaded.
    write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.pkg.json" }] }));
    write("tsconfig.base.json", JSON.stringify({ include: ["packages/pkg/src/**/*.ts"] }));
    write("tsconfig.pkg.json", JSON.stringify({ extends: "./tsconfig.base.json" }));
    write("decoy.ts", "export const decoy = 1;\n");
    write("packages/pkg/src/real.ts", "export const real = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toContain(path.join("packages", "pkg", "src", "real.ts"));
  });

  it("follows an extends chain given as an array", () => {
    write("tsconfig.json", JSON.stringify({ extends: ["./base-a.json", "./base-b.json"] }));
    write("base-a.json", JSON.stringify({ compilerOptions: { strict: true } }));
    write("base-b.json", JSON.stringify({ include: ["src/**/*.ts"] }));
    write("src/only.ts", "export const only = 1;\n");
    write("elsewhere/other.ts", "export const other = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toEqual([path.join("src", "only.ts")]);
  });

  it("takes the LAST array-extends base that declares a file surface", () => {
    // TypeScript's array `extends` is last-wins: base-b's include overrides
    // base-a's. Walking the array front-to-back and stopping at the first
    // answer inverts that and lands the representative in the wrong project.
    write("tsconfig.json", JSON.stringify({ extends: ["./base-a.json", "./base-b.json"] }));
    write("base-a.json", JSON.stringify({ include: ["overridden/**/*.ts"] }));
    write("base-b.json", JSON.stringify({ include: ["winner/**/*.ts"] }));
    write("overridden/loser.ts", "export const loser = 1;\n");
    write("winner/real.ts", "export const real = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toEqual([path.join("winner", "real.ts")]);
  });

  it("emits no representative for a solution-style root that owns no files", () => {
    // `files: []` is a declared-and-empty surface, not an absent one: the
    // referenced projects carry every file, so a representative for the root
    // would load an extra project buying no reference coverage.
    write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.libs.json" }] }));
    write("tsconfig.libs.json", JSON.stringify({ include: ["libs/**/*.ts"] }));
    write("libs/one.ts", "export const one = 1;\n");
    write("stray.ts", "export const stray = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toEqual([path.join("libs", "one.ts")]);
  });

  it("survives a workspace with no tsconfig at all", () => {
    write("src/only.ts", "export const only = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toEqual([path.join("src", "only.ts")]);
  });

  it("resolves a reference that names a directory", () => {
    write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./packages/core" }] }));
    write("packages/core/tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"] }));
    write("packages/core/src/index.ts", "export const core = 1;\n");

    const reps = discoverProjectRepresentatives(root).map((p) => path.relative(root, p));

    expect(reps).toContain(path.join("packages", "core", "src", "index.ts"));
  });
});
