import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LingeringRefsOptions {
  workspaceRoot: string;
  oldName: string;
  excludePaths: string[];
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

const MAX_FILE_SIZE = 1_000_000; // 1 MB

export function findLingeringReferences(opts: LingeringRefsOptions): string[] {
  const { workspaceRoot, oldName, excludePaths } = opts;
  const excludeSet = new Set(excludePaths.map((p) => path.resolve(p)));
  const pattern = new RegExp(`\\b${escapeRegex(oldName)}\\b`);

  // Prefer git grep when the workspace is a git repo — honors .gitignore
  if (isGitRepo(workspaceRoot)) {
    try {
      const output = execFileSync(
        "git",
        ["grep", "-l", "-E", pattern.source, "--", ":!node_modules", ":!dist", ":!build"],
        { cwd: workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return output
        .split("\n")
        .filter(Boolean)
        .map((rel) => path.resolve(workspaceRoot, rel))
        .filter((abs) => !excludeSet.has(abs));
    } catch (err) {
      // git grep exits 1 when no matches — that's the happy path
      if ((err as { status?: number })?.status === 1) return [];
      // Other failures fall through to FS walk
    }
  }

  return walkAndGrep(workspaceRoot, pattern, excludeSet);
}

function walkAndGrep(
  root: string,
  pattern: RegExp,
  excludeSet: Set<string>,
): string[] {
  const matches: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;
        const full = path.join(dir, entry.name);
        if (excludeSet.has(full)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(full, "utf8");
          if (pattern.test(content)) matches.push(full);
        } catch {
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
