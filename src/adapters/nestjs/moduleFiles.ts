import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { toExcludeGlobs } from '../../utils/pathFilter.js';
import { toPosixPath } from '../../utils/fsSafe.js';

export interface ModuleTsFile {
  absPath: string;
  dirAbsPath: string;
}

/** Every *.module.ts defines one NestJS module boundary — its containing directory is the module root. */
export async function findModuleTsFiles(projectRoot: string, exclude: string[]): Promise<ModuleTsFile[]> {
  const relFiles = await fg('**/*.module.ts', {
    cwd: projectRoot,
    onlyFiles: true,
    ignore: toExcludeGlobs(exclude),
  });
  return relFiles.map((relFile) => {
    const absPath = path.join(projectRoot, relFile);
    return { absPath, dirAbsPath: path.dirname(absPath) };
  });
}

const CLASS_NAME_PATTERN = /export\s+class\s+(\w+)/;

export async function readModuleClassName(moduleTsAbsPath: string): Promise<string | null> {
  try {
    const source = await fs.readFile(moduleTsAbsPath, 'utf8');
    return CLASS_NAME_PATTERN.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function toPosixRelPath(from: string, to: string): string {
  return toPosixPath(path.relative(from, to));
}
