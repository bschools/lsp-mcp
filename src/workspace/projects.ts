import * as fs from "node:fs";
import * as path from "node:path";
import { isWatchableSourceFile, shouldSkipDir } from "../lsp/source-filter.js";

/**
 * Project discovery for warmup.
 *
 * tsserver loads a configured project only when a file belonging to it is
 * opened, and it answers semantic requests from whatever projects are loaded
 * at that moment — a `textDocument/references` issued before the referencing
 * projects load silently returns a subset. Opening one file per configured
 * project is what makes the graph complete; opening N arbitrary files is not,
 * because N files from the same project load the same single project.
 *
 * Measured on a 2063-file monorepo with a solution-style root tsconfig
 * (`files: []` + three references): 500 breadth-first files → 4 of 8
 * referencing files found; 3 project representatives → 8 of 8, and faster.
 */

const WILDCARD = /[*?[{]/;

/**
 * Strip JSONC comments and trailing commas, string-aware.
 *
 * Regex stripping is not an option here: tsconfig values are full of path
 * globs, and `"@libs/*": ["libs/*"]` followed later by `"**\/*.spec.ts"` reads
 * as an opened and closed block comment to any scanner that ignores string
 * boundaries — which silently deletes everything between them.
 */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j]!)) j--;
      if (j >= 0 && out[j] === ",") out = out.slice(0, j) + out.slice(j + 1);
    }
    out += ch;
  }

  return out;
}

/** Parse a tsconfig (JSONC: line/block comments and trailing commas allowed). */
export function parseTsconfig(text: string): Record<string, unknown> | null {
  const stripped = stripJsonc(text);
  try {
    const parsed: unknown = JSON.parse(stripped);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readConfig(configPath: string): Record<string, unknown> | null {
  try {
    return parseTsconfig(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve a `references[].path` entry, which may name a file or a directory. */
function resolveReference(configDir: string, refPath: string): string | null {
  const resolved = path.resolve(configDir, refPath);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      const nested = path.join(resolved, "tsconfig.json");
      return fs.existsSync(nested) ? nested : null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/** The config plus every project it references, transitively. */
function collectReferencedConfigs(
  configPath: string,
  seen: Set<string>,
): string[] {
  if (seen.has(configPath)) return [];
  seen.add(configPath);
  const config = readConfig(configPath);
  if (!config) return [configPath];

  const out = [configPath];
  const refs = config.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      const refPath = (ref as { path?: unknown })?.path;
      if (typeof refPath !== "string") continue;
      const resolved = resolveReference(path.dirname(configPath), refPath);
      if (resolved) out.push(...collectReferencedConfigs(resolved, seen));
    }
  }
  return out;
}

/** Every tsconfig.json in the tree — projects the root does not reference still own files. */
function findNestedConfigs(root: string): string[] {
  const found: string[] = [];
  const queue = [root];
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
        if (!shouldSkipDir(entry.name)) queue.push(path.join(dir, entry.name));
      } else if (entry.name === "tsconfig.json" && dir !== root) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

/**
 * Directories a project's `include`/`files` point at. A glob contributes the
 * literal path segments before its first wildcard (`libs/**\/*.ts` → `libs`),
 * which is all that is needed to go looking for one file the project owns.
 */
function declaredRoots(configPath: string): string[] | null {
  const configDir = path.dirname(configPath);
  const config = readConfig(configPath);
  const roots: string[] = [];
  let declaresFileSurface = false;

  for (const key of ["files", "include"] as const) {
    const patterns = config?.[key];
    if (!Array.isArray(patterns)) continue;
    declaresFileSurface = true;
    for (const pattern of patterns) {
      if (typeof pattern !== "string") continue;
      const wildcardAt = pattern.search(WILDCARD);
      if (wildcardAt === -1) {
        roots.push(path.resolve(configDir, pattern));
        continue;
      }
      const slash = pattern.lastIndexOf("/", wildcardAt);
      roots.push(path.resolve(configDir, slash === -1 ? "." : pattern.slice(0, slash)));
    }
  }

  // Null means "declares no file surface at all", which is a different fact
  // from a solution-style `files: []` — the first inherits through `extends`,
  // the second genuinely owns nothing.
  return declaresFileSurface ? roots : null;
}

/**
 * `extends` targets in resolution priority order — highest first.
 *
 * TypeScript 5 allows a string or an array, and an array is LAST-wins: a later
 * base overrides what an earlier one declared. Callers here take the first
 * target that answers, so the array is reversed to make "first that answers"
 * and "last that declared it" the same entry.
 */
function extendsTargets(config: Record<string, unknown> | null): string[] {
  const value = config?.extends;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string").reverse();
  }
  return [];
}

/**
 * A config that declares neither `files` nor `include` inherits its file
 * surface through `extends`, so the chain is followed before falling back to
 * the config's own directory. Without this, a leaf project whose `include`
 * lives in a shared base resolves to the repo root, and its representative can
 * land in an entirely different project — leaving the real one unloaded and
 * its files missing from every reference result.
 *
 * Relative patterns resolve against the directory of the config they were
 * written in, per TypeScript's own rule, which is why roots come back already
 * resolved rather than as raw patterns.
 */
function inheritedRoots(configPath: string, depth: number): string[] | null {
  const MAX_EXTENDS_DEPTH = 8;
  if (depth >= MAX_EXTENDS_DEPTH) return null;

  for (const target of extendsTargets(readConfig(configPath))) {
    // Bare specifiers (`@tsconfig/node20/tsconfig.json`) resolve through node
    // module resolution, which is out of scope here — only relative bases are
    // followed, and those are the ones carrying repo-local include globs.
    if (!target.startsWith(".")) continue;
    const base = resolveReference(path.dirname(configPath), target);
    if (!base) continue;
    const roots = declaredRoots(base) ?? inheritedRoots(base, depth + 1);
    if (roots && roots.length > 0) return roots;
  }
  return null;
}

/**
 * Where to go looking for a project's representative file, in precedence
 * order: what the config declares itself, else what it inherits through
 * `extends`, else its own directory.
 *
 * A declared-but-empty surface is honoured as empty. A solution-style config
 * (`files: []` plus `references`) owns no files — its referenced projects
 * carry the whole surface — so it yields no roots and no representative, and
 * loading an extra project for zero reference coverage is avoided.
 */
function includeRoots(configPath: string): string[] {
  const own = declaredRoots(configPath);
  if (own !== null) return own;

  return inheritedRoots(configPath, 0) ?? [path.dirname(configPath)];
}

/** First source file at or under `target`, breadth-first. */
function firstSourceFile(target: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return undefined;
  }
  if (stat.isFile()) {
    return isWatchableSourceFile(target) ? target : undefined;
  }

  const queue = [target];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) subdirs.push(full);
      } else if (entry.isFile() && isWatchableSourceFile(entry.name)) {
        return full;
      }
    }
    queue.push(...subdirs);
  }
  return undefined;
}

/**
 * One source file per configured project — the set to open at startup so
 * tsserver has loaded every project before the first semantic request.
 */
export function discoverProjectRepresentatives(workspaceRoot: string): string[] {
  const rootConfig = path.join(workspaceRoot, "tsconfig.json");
  const seen = new Set<string>();
  const configs = fs.existsSync(rootConfig)
    ? collectReferencedConfigs(rootConfig, seen)
    : [];
  for (const nested of findNestedConfigs(workspaceRoot)) {
    configs.push(...collectReferencedConfigs(nested, seen));
  }

  const representatives = new Set<string>();
  const sources = configs.length > 0 ? configs : [rootConfig];
  for (const configPath of sources) {
    for (const root of includeRoots(configPath)) {
      const file = firstSourceFile(root);
      if (file) representatives.add(file);
    }
  }

  // No tsconfig at all (or none resolvable): fall back to any one source file
  // so the workspace still gets an inferred project up front.
  if (representatives.size === 0) {
    const any = firstSourceFile(workspaceRoot);
    if (any) representatives.add(any);
  }

  return [...representatives];
}
