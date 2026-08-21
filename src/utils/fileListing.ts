import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { SourceFileRef } from '../adapters/types.js';
import { toPosixPath } from './fsSafe.js';
import { isIncluded, toExcludeGlobs } from './pathFilter.js';

export interface ListFilesOptions {
  exclude: string[];
  include: string[];
  /** fast-glob pattern(s); defaults to every file. */
  patterns?: string | string[];
}

/** Recursively lists files under rootPath, applying exclude/include the same way across every adapter. */
export async function listFilesUnderDir(rootPath: string, options: ListFilesOptions): Promise<SourceFileRef[]> {
  let exists = true;
  try {
    await fs.access(rootPath);
  } catch {
    exists = false;
  }
  if (!exists) return [];

  const entries = await fg(options.patterns ?? '**/*', {
    cwd: rootPath,
    onlyFiles: true,
    dot: false,
    ignore: toExcludeGlobs(options.exclude),
  });

  const refs: SourceFileRef[] = [];
  for (const relPath of entries.filter((relPath) => isIncluded(relPath, options.include))) {
    const absPath = path.join(rootPath, relPath);
    const stat = await fs.stat(absPath);
    refs.push({ absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size });
  }
  return refs;
}
