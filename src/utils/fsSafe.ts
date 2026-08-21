import path from 'node:path';

/**
 * Resolves `relPath` under `root` and rejects any result that escapes `root`
 * (guards against ".." traversal from adapter-computed or config-driven paths).
 */
export function safeJoin(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path traversal rejected: "${relPath}" escapes root "${resolvedRoot}"`);
  }
  return resolved;
}

export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}
