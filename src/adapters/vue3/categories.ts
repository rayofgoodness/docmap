import path from 'node:path';
import type { ElementDescriptor, ElementKind, ModuleDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { listFilesUnderDir } from '../../utils/fileListing.js';

const VUE_FILE_PATTERNS = ['**/*.{ts,tsx,js,jsx,mjs,vue}'];

export interface CategoryDef {
  id: string;
  name: string;
  /** Tried in order — different scaffolds name the same concept differently (views vs pages). */
  dirNames: string[];
  elementKind: ElementKind;
}

export const APP_CATEGORIES: CategoryDef[] = [
  { id: 'views', name: 'Views', dirNames: ['views', 'pages'], elementKind: 'page' },
  { id: 'components', name: 'Components', dirNames: ['components'], elementKind: 'component' },
  { id: 'composables', name: 'Composables', dirNames: ['composables', 'hooks'], elementKind: 'composable' },
  { id: 'layouts', name: 'Layouts', dirNames: ['layouts'], elementKind: 'layout' },
  { id: 'stores', name: 'Stores', dirNames: ['stores', 'store'], elementKind: 'store' },
  { id: 'router', name: 'Router', dirNames: ['router'], elementKind: 'file' },
];

export async function buildCategoryModule(
  category: CategoryDef,
  appRoot: string,
  projectRoot: string,
  exclude: string[],
  include: string[],
): Promise<ModuleDescriptor | null> {
  for (const dirName of category.dirNames) {
    const categoryRootAbsPath = path.join(appRoot, dirName);
    const files = await listFilesUnderDir(categoryRootAbsPath, { exclude, include, patterns: VUE_FILE_PATTERNS });
    if (files.length === 0) continue;

    const elements: ElementDescriptor[] = files.map((file) => ({
      id: file.relPath,
      kind: category.elementKind,
      name: path.basename(file.relPath),
      files: [file],
    }));

    return {
      id: category.id,
      name: category.name,
      rootPath: categoryRootAbsPath,
      relRootPath: toPosixPath(path.relative(projectRoot, categoryRootAbsPath)),
      framework: 'vue3',
      elements,
      relations: [],
      files,
    };
  }

  return null;
}
