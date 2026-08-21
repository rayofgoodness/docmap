import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { SourceFileRef } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';

export async function listFilesUnder(dirAbsPath: string, exclude: string[]): Promise<SourceFileRef[]> {
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
    ignore: exclude.map((e) => `**/${e}/**`),
  });

  const refs: SourceFileRef[] = [];
  for (const relPath of entries) {
    const absPath = path.join(dirAbsPath, relPath);
    const stat = await fs.stat(absPath);
    refs.push({ absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size });
  }
  return refs;
}
