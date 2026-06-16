import { describe, it, expect } from "vitest";
import { isWatchableSourceFile, shouldSkipDir } from "../../src/lsp/source-filter.js";

describe("isWatchableSourceFile", () => {
  it("accepts .ts/.tsx/.mts/.cts files", () => {
    expect(isWatchableSourceFile("/a/b/foo.ts")).toBe(true);
    expect(isWatchableSourceFile("foo.tsx")).toBe(true);
    expect(isWatchableSourceFile("foo.mts")).toBe(true);
    expect(isWatchableSourceFile("foo.cts")).toBe(true);
  });

  it("rejects non-TypeScript extensions", () => {
    expect(isWatchableSourceFile("foo.js")).toBe(false);
    expect(isWatchableSourceFile("foo.jsx")).toBe(false);
    expect(isWatchableSourceFile("foo.json")).toBe(false);
    expect(isWatchableSourceFile("foo.md")).toBe(false);
    expect(isWatchableSourceFile("README")).toBe(false);
  });

  it("mirrors warmUpWorkspace extname semantics (.d.ts counts as .ts)", () => {
    // path.extname("foo.d.ts") === ".ts" — warmUpWorkspace opens declaration
    // files today, so the shared predicate must too (no behavioral drift).
    expect(isWatchableSourceFile("/path/foo.d.ts")).toBe(true);
  });
});

describe("shouldSkipDir", () => {
  it("skips the warmup skip-set directories", () => {
    expect(shouldSkipDir("node_modules")).toBe(true);
    expect(shouldSkipDir("dist")).toBe(true);
    expect(shouldSkipDir(".git")).toBe(true);
    expect(shouldSkipDir("build")).toBe(true);
    expect(shouldSkipDir("out")).toBe(true);
  });

  it("skips any dotdir", () => {
    expect(shouldSkipDir(".vscode")).toBe(true);
    expect(shouldSkipDir(".cache")).toBe(true);
    expect(shouldSkipDir(".yarn")).toBe(true);
  });

  it("descends ordinary source directories", () => {
    expect(shouldSkipDir("src")).toBe(false);
    expect(shouldSkipDir("lib")).toBe(false);
    expect(shouldSkipDir("test")).toBe(false);
    expect(shouldSkipDir("components")).toBe(false);
  });
});
