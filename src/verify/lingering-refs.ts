import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export interface LingeringRefsOptions {
  workspaceRoot: string;
  oldName: string;
  excludePaths: string[];
  /** Override the default identifier-boundary pattern. Useful for specifier-aware searches. */
  patternOverride?: RegExp;
  deadlineMs?: number;
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".turbo",
  "coverage",
]);

export class ResidualDiscoveryDeadlineExceeded extends Error {
  constructor() {
    super("residual discovery exceeded the verification time budget");
    this.name = "ResidualDiscoveryDeadlineExceeded";
  }
}

function assertWithinDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new ResidualDiscoveryDeadlineExceeded();
  }
}

export function findLingeringReferences(opts: LingeringRefsOptions): string[] {
  const { workspaceRoot, oldName, excludePaths, patternOverride, deadlineMs } = opts;
  assertWithinDeadline(deadlineMs);
  const excludeSet = new Set(excludePaths.map((p) => path.resolve(p)));
  const pattern = patternOverride ?? new RegExp(`(?<![\\w$])${escapeRegex(oldName)}(?![\\w$])`);

  // Prefer git grep when the workspace is a git repo — honors .gitignore.
  // Use -P (PCRE) for identifier boundaries; falls through to FS walk if
  // the git build lacks libpcre (non-1 exit).
  if (isGitRepo(workspaceRoot)) {
    try {
      const output = execFileSync(
        "git",
        ["grep", "-l", "--untracked", "-P", pattern.source, "--", ":!node_modules", ":!dist", ":!build"],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: deadlineMs === undefined ? undefined : Math.max(1, deadlineMs - Date.now()),
        },
      );
      assertWithinDeadline(deadlineMs);
      return output
        .split("\n")
        .filter(Boolean)
        .map((rel) => path.resolve(workspaceRoot, rel))
        .filter((abs) => !excludeSet.has(abs));
    } catch (err) {
      if (err instanceof ResidualDiscoveryDeadlineExceeded) throw err;
      if ((err as NodeJS.ErrnoException)?.code === "ETIMEDOUT") {
        throw new ResidualDiscoveryDeadlineExceeded();
      }
      assertWithinDeadline(deadlineMs);
      // git grep exits 1 when no matches — that's the happy path
      if ((err as { status?: number })?.status === 1) return [];
      // Other failures fall through to FS walk
    }
  }

  return walkAndGrep(workspaceRoot, pattern, excludeSet, deadlineMs);
}

function walkAndGrep(
  root: string,
  pattern: RegExp,
  excludeSet: Set<string>,
  deadlineMs: number | undefined,
): string[] {
  const matches: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    assertWithinDeadline(deadlineMs);
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      assertWithinDeadline(deadlineMs);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;
        const full = path.join(dir, entry.name);
        if (excludeSet.has(full)) continue;
        try {
          const content = fs.readFileSync(full, "utf8");
          assertWithinDeadline(deadlineMs);
          if (pattern.test(content)) matches.push(full);
          assertWithinDeadline(deadlineMs);
        } catch {
          assertWithinDeadline(deadlineMs);
          // Skip unreadable files
        }
      }
    }
  }

  return matches;
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export type IdentifierCandidate = {
  path: string;
  /** 0-based, LSP-native. */
  line: number;
  /** 0-based, LSP-native. */
  character: number;
};

export type InformationalMention = {
  path: string;
  /** 0-based, LSP-native. */
  line: number;
  kind: "string" | "template" | "comment";
};

export type ResidualCandidates = {
  identifierCandidates: IdentifierCandidate[];
  informationalMentions: InformationalMention[];
};

export type ResidualCandidatesOptions = {
  workspaceRoot: string;
  oldName: string;
  deadlineMs?: number;
};

/**
 * Token-aware pass over the text-match paths (edited files included). Identifier
 * tokens equal to oldName are candidates; occurrences inside string, template, or
 * comment tokens are informational. Homonyms (property names etc.) stay candidates.
 */
export function findResidualCandidates(opts: ResidualCandidatesOptions): ResidualCandidates {
  const { workspaceRoot, oldName, deadlineMs } = opts;
  assertWithinDeadline(deadlineMs);
  const result: ResidualCandidates = { identifierCandidates: [], informationalMentions: [] };
  const paths = findLingeringReferences({ workspaceRoot, oldName, excludePaths: [], deadlineMs }).filter((p) =>
    SOURCE_EXTENSIONS.has(path.extname(p)),
  );
  const inner = new RegExp(`(?<![\\w$])${escapeRegex(oldName)}(?![\\w$])`, "g");

  for (const file of paths) {
    assertWithinDeadline(deadlineMs);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    assertWithinDeadline(deadlineMs);
    const lineStarts = computeLineStarts(text);
    assertWithinDeadline(deadlineMs);
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const mention = (
      start: number,
      tokenText: string,
      kind: InformationalMention["kind"],
    ): void => {
      inner.lastIndex = 0;
      for (let m = inner.exec(tokenText); m; m = inner.exec(tokenText)) {
        result.informationalMentions.push({ path: file, line: lineOf(start + m.index), kind });
      }
    };

    const jsx = /\.(tsx|jsx)$/.test(file);
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
      text,
    );
    // A bare scanner does not track JSX context: an apostrophe or backtick in
    // JSX text would open a string or template that swallows real identifiers.
    // The parser knows where JsxText runs; the scan skips over each one.
    const jsxTextEnds = jsx ? collectJsxTextRanges(file, text) : new Map<number, number>();
    assertWithinDeadline(deadlineMs);
    const templateStack: boolean[] = []; // true = template substitution, false = plain brace
    let prev: ts.SyntaxKind = ts.SyntaxKind.Unknown;
    let tokenCount = 0;
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (++tokenCount % 256 === 0) assertWithinDeadline(deadlineMs);
      if (kind === ts.SyntaxKind.CloseBraceToken && templateStack[templateStack.length - 1]) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templateStack.pop();
      } else if (
        (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) &&
        !endsExpression(prev)
      ) {
        kind = scanner.reScanSlashToken();
      }
      const start = scanner.getTokenStart();
      const jsxTextEnd = jsxTextEnds.get(start);
      if (jsxTextEnd !== undefined) {
        mention(start, text.slice(start, jsxTextEnd), "string");
        scanner.resetTokenState(jsxTextEnd);
        prev = ts.SyntaxKind.JsxText;
        continue;
      }
      switch (kind) {
        case ts.SyntaxKind.Identifier:
          if (scanner.getTokenValue() === oldName) {
            const line = lineOf(start);
            result.identifierCandidates.push({
              path: file,
              line,
              character: start - lineStarts[line],
            });
          }
          break;
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.JsxText:
          mention(start, scanner.getTokenText(), "string");
          break;
        case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        case ts.SyntaxKind.TemplateMiddle:
        case ts.SyntaxKind.TemplateTail:
          mention(start, scanner.getTokenText(), "template");
          break;
        case ts.SyntaxKind.TemplateHead:
          templateStack.push(true);
          mention(start, scanner.getTokenText(), "template");
          break;
        case ts.SyntaxKind.SingleLineCommentTrivia:
        case ts.SyntaxKind.MultiLineCommentTrivia:
          mention(start, scanner.getTokenText(), "comment");
          break;
        case ts.SyntaxKind.OpenBraceToken:
          templateStack.push(false);
          break;
        case ts.SyntaxKind.CloseBraceToken:
          templateStack.pop();
          break;
      }
      if (
        kind !== ts.SyntaxKind.WhitespaceTrivia &&
        kind !== ts.SyntaxKind.NewLineTrivia &&
        kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
        kind !== ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        prev = kind;
      }
    }
    assertWithinDeadline(deadlineMs);
  }
  return result;
}

/** Start offset -> end offset of every non-empty JsxText node in the file. */
function collectJsxTextRanges(file: string, text: string): Map<number, number> {
  const kind = file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const ranges = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (node.end > node.pos) ranges.set(node.pos, node.end);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ranges;
}

function endsExpression(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.Identifier ||
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateTail ||
    kind === ts.SyntaxKind.CloseParenToken ||
    kind === ts.SyntaxKind.CloseBracketToken ||
    kind === ts.SyntaxKind.CloseBraceToken ||
    kind === ts.SyntaxKind.ThisKeyword ||
    kind === ts.SyntaxKind.SuperKeyword ||
    kind === ts.SyntaxKind.TrueKeyword ||
    kind === ts.SyntaxKind.FalseKeyword ||
    kind === ts.SyntaxKind.NullKeyword
  );
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}
