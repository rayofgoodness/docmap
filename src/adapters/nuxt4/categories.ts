import path from 'node:path';
import type { ElementDescriptor, ElementKind, ModuleDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { listFilesUnder } from './scan.js';

export interface CategoryDef {
  id: string;
  name: string;
  dirName: string;
  elementKind: ElementKind;
}

export const APP_CATEGORIES: CategoryDef[] = [
  { id: 'pages', name: 'Pages', dirName: 'pages', elementKind: 'page' },
  { id: 'components', name: 'Components', dirName: 'components', elementKind: 'component' },
  { id: 'composables', name: 'Composables', dirName: 'composables', elementKind: 'composable' },
  { id: 'layouts', name: 'Layouts', dirName: 'layouts', elementKind: 'layout' },
  { id: 'middleware', name: 'Middleware', dirName: 'middleware', elementKind: 'middleware' },
  { id: 'stores', name: 'Stores', dirName: 'stores', elementKind: 'store' },
];

export async function buildCategoryModule(
  category: CategoryDef,
  categoryRootAbsPath: string,
  projectRoot: string,
  exclude: string[],
): Promise<ModuleDescriptor | null> {
  const files = await listFilesUnder(categoryRootAbsPath, exclude);
  if (files.length === 0) return null;

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
    framework: 'nuxt4',
    elements,
    relations: [],
    files,
  };
}
