import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectWorkspaceRoot } from "../../src/workspace/detect.js";

describe("detectWorkspaceRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("picks nearest tsconfig.json with compilerOptions (monorepo)", () => {
    const outer = tmpDir;
    const inner = path.join(outer, "apps", "web");
    fs.mkdirSync(inner, { recursive: true });

    // Outer is a references-only shim
    fs.writeFileSync(
      path.join(outer, "tsconfig.json"),
      JSON.stringify({ references: [{ path: "./apps/web" }] }),
    );
    // Inner has compilerOptions — should win
    fs.writeFileSync(
      path.join(inner, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );

    const src = path.join(inner, "src", "file.ts");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "");

    expect(detectWorkspaceRoot(src)).toBe(inner);
  });

  it("falls back to package.json dir when no tsconfig", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const src = path.join(tmpDir, "src", "file.js");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "");

    expect(detectWorkspaceRoot(src)).toBe(tmpDir);
  });
});
