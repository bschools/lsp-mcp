/**
 * Per-file grouping for rename_symbol's advisory and unclassified fields, so
 * the response grows with the number of files rather than occurrences.
 */

export type FileCount = { path: string; count: number };
export type FileKinds<K extends string> = FileCount & { kinds: K[] };

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** One {path, count, kinds} entry per file, sorted by path; kinds are the sorted distinct kinds. */
export function groupKindsByFile<K extends string>(
  entries: ReadonlyArray<{ path: string; kind: K }>,
): Array<FileKinds<K>> {
  const files = new Map<string, { count: number; kinds: Set<K> }>();
  for (const { path, kind } of entries) {
    const file = files.get(path) ?? { count: 0, kinds: new Set<K>() };
    file.count++;
    file.kinds.add(kind);
    files.set(path, file);
  }
  return [...files]
    .map(([path, { count, kinds }]) => ({ path, count, kinds: [...kinds].sort() }))
    .sort(byPath);
}

/** One {path, count} entry per file, sorted by path. */
export function groupCandidatesByFile(entries: ReadonlyArray<{ path: string }>): FileCount[] {
  const counts = new Map<string, number>();
  for (const { path } of entries) counts.set(path, (counts.get(path) ?? 0) + 1);
  return [...counts].map(([path, count]) => ({ path, count })).sort(byPath);
}
