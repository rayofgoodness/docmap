import micromatch from 'micromatch';

function toGlobs(names: string[]): string[] {
  return names.flatMap((n) => {
    if (n.includes('*') || n.includes('/')) return [n];
    // A bare name may refer to a directory (match everything under it) or a leaf file (match it directly).
    return [`**/${n}`, `**/${n}/**`];
  });
}

/** exclude entries are either bare names ("vendor") or glob patterns — bare names are expanded to match that directory anywhere in the tree. */
export function toExcludeGlobs(exclude: string[]): string[] {
  return toGlobs(exclude);
}

/** include is an allow-list using the same pattern syntax as exclude; an empty list means "no restriction". */
export function isIncluded(relPath: string, include: string[]): boolean {
  if (include.length === 0) return true;
  return micromatch.isMatch(relPath, toGlobs(include), { dot: true });
}
