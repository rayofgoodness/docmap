import path from 'node:path';
import type { ModuleDescriptor } from '../adapters/types.js';

/** Resolves a relative or `~/`/`@/`-aliased import specifier to an absolute path; null for a bare specifier (npm package or auto-import) — not deterministically resolvable. */
export function resolveAliasedImport(
  target: string,
  fileAbsDir: string,
  appRoot: string,
  projectRoot: string,
): string | null {
  if (target.startsWith('.')) return path.resolve(fileAbsDir, target);
  if (target.startsWith('~~/') || target.startsWith('@@/')) return path.resolve(projectRoot, target.slice(3));
  if (target.startsWith('~/') || target.startsWith('@/')) return path.resolve(appRoot, target.slice(2));
  return null;
}

export function findOwningModule(modules: ModuleDescriptor[], resolvedAbsPath: string): ModuleDescriptor | undefined {
  return modules.find((m) => resolvedAbsPath === m.rootPath || resolvedAbsPath.startsWith(m.rootPath + path.sep));
}
