import path from 'node:path';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import type { ElementDescriptor, ElementKind, SourceFileRef } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';

const KIND_BY_TOP_DIR: Record<string, ElementKind> = {
  Controller: 'controller',
  Model: 'model',
  Observer: 'observer',
  Plugin: 'plugin',
  Block: 'block',
  Api: 'api',
  Helper: 'helper',
  Setup: 'setup',
};

export async function collectModuleElements(
  moduleRootAbsPath: string,
  exclude: string[],
): Promise<{ elements: ElementDescriptor[]; files: SourceFileRef[] }> {
  const phpFiles = await fg(Object.keys(KIND_BY_TOP_DIR).map((dir) => `${dir}/**/*.php`), {
    cwd: moduleRootAbsPath,
    onlyFiles: true,
    ignore: exclude.map((e) => `**/${e}/**`),
  });

  const elements: ElementDescriptor[] = [];
  const files: SourceFileRef[] = [];

  for (const relPath of phpFiles) {
    const absPath = path.join(moduleRootAbsPath, relPath);
    const stat = await fs.stat(absPath);
    const file: SourceFileRef = { absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size };
    files.push(file);

    const topDir = relPath.split(path.sep)[0] as string;
    const kind = KIND_BY_TOP_DIR[topDir] ?? 'unknown';

    elements.push({
      id: file.relPath,
      kind,
      name: path.basename(relPath, '.php'),
      files: [file],
    });
  }

  return { elements, files };
}
