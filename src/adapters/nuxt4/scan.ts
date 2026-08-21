import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { SourceFileRef } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { isIncluded, toExcludeGlobs } from '../../utils/pathFilter.js';

export async function listFilesUnder(
  dirAbsPath: string,
  exclude: string[],
  include: string[] = [],
): Promise<SourceFileRef[]> {
  let exists = true;
  try {
    await fs.access(dirAbsPath);
  } catch {
    exists = false;
  }
  if (!exists) return [];

  const entries = await fg('**/*.{ts,tsx,js,jsx,mjs,vue}', {
    cwd: dirAbsPath,
    onlyFiles: true,
    ignore: toExcludeGlobs(exclude),
  });

  const refs: SourceFileRef[] = [];
  for (const relPath of entries.filter((relPath) => isIncluded(relPath, include))) {
    const absPath = path.join(dirAbsPath, relPath);
    const stat = await fs.stat(absPath);
    refs.push({ absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size });
  }
  return refs;
}
