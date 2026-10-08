import { describe, expect, it } from "vitest";
import { groupCandidatesByFile, groupKindsByFile } from "../../src/verify/group-by-file.js";

describe("groupKindsByFile", () => {
  it("returns one entry per file sorted by path with exact counts and sorted distinct kinds", () => {
    const entries = [
      { path: "/ws/src/b.ts", line: 1, kind: "string" as const },
      { path: "/ws/src/a.ts", line: 4, kind: "comment" as const },
      { path: "/ws/src/b.ts", line: 2, kind: "comment" as const },
      { path: "/ws/src/b.ts", line: 9, kind: "string" as const },
      { path: "/ws/src/a.ts", line: 7, kind: "comment" as const },
    ];

    expect(groupKindsByFile(entries)).toEqual([
      { path: "/ws/src/a.ts", count: 2, kinds: ["comment"] },
      { path: "/ws/src/b.ts", count: 3, kinds: ["comment", "string"] },
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(groupKindsByFile([])).toEqual([]);
  });
});

describe("groupCandidatesByFile", () => {
  it("returns one entry per file sorted by path with exact counts", () => {
    const entries = [
      { path: "/ws/src/z.ts", line: 0, character: 3 },
      { path: "/ws/src/m.ts", line: 1, character: 0 },
      { path: "/ws/src/z.ts", line: 5, character: 8 },
    ];

    expect(groupCandidatesByFile(entries)).toEqual([
      { path: "/ws/src/m.ts", count: 1 },
      { path: "/ws/src/z.ts", count: 2 },
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(groupCandidatesByFile([])).toEqual([]);
  });
});
