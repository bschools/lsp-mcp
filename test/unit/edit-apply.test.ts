import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { applyWorkspaceEdit } from "../../src/workspace/edit-apply.js";

describe("applyWorkspaceEdit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-apply-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies single-line edit via changes map", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "const UserService = 1;\n");

    const changed = applyWorkspaceEdit({
      changes: {
        [url.pathToFileURL(file).href]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 17 } },
            newText: "AccountService",
          },
        ],
      },
    });

    expect(changed).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe("const AccountService = 1;\n");
  });

  it("applies multiple edits in reverse offset order (same line)", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "aaa bbb ccc\n");

    applyWorkspaceEdit({
      changes: {
        [url.pathToFileURL(file).href]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "XXX",
          },
          {
            range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } },
            newText: "YYY",
          },
        ],
      },
    });

    expect(fs.readFileSync(file, "utf8")).toBe("XXX bbb YYY\n");
  });

  it("supports documentChanges variant", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "hello\n");

    const changed = applyWorkspaceEdit({
      documentChanges: [
        {
          textDocument: { uri: url.pathToFileURL(file).href },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: "world",
            },
          ],
        },
      ],
    });

    expect(changed).toEqual([file]);
    expect(fs.readFileSync(file, "utf8")).toBe("world\n");
  });

  it("skips files whose content would not change", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "hello\n");

    const changed = applyWorkspaceEdit({
      changes: {
        [url.pathToFileURL(file).href]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            newText: "hello",
          },
        ],
      },
    });

    expect(changed).toEqual([]);
  });
});
