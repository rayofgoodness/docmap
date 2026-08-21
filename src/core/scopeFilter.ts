import path from 'node:path';
import type { SourceFileRef } from '../adapters/types.js';
import { toPosixPath } from '../utils/fsSafe.js';
import { loadGitignore, type Ignore } from '../utils/gitignore.js';

export interface ScopeFilters {
  gitignore: Ignore | null;
  /** posix, no leading/trailing slash; null means "no --dir restriction" */
  scanDirPrefix: string | null;
}

export async function loadScopeFilters(projectRoot: string, scanDir?: string): Promise<ScopeFilters> {
  const gitignore = await loadGitignore(projectRoot);

  let scanDirPrefix: string | null = null;
  if (scanDir) {
    const abs = path.resolve(projectRoot, scanDir);
    const rel = toPosixPath(path.relative(projectRoot, abs));
    scanDirPrefix = rel === '' ? null : rel;
  }

  return { gitignore, scanDirPrefix };
}

export function isInScope(absPath: string, projectRoot: string, filters: ScopeFilters): boolean {
  const rel = toPosixPath(path.relative(projectRoot, absPath));
  if (rel.startsWith('..')) return false;
  if (filters.gitignore?.ignores(rel)) return false;
  if (filters.scanDirPrefix && rel !== filters.scanDirPrefix && !rel.startsWith(`${filters.scanDirPrefix}/`)) {
    return false;
  }
  return true;
}

export function filterFilesInScope<T extends SourceFileRef>(
  files: T[],
  projectRoot: string,
  filters: ScopeFilters,
): T[] {
  return files.filter((f) => isInScope(f.absPath, projectRoot, filters));
}
