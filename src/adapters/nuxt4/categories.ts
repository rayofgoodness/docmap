import fs from 'node:fs/promises';
import path from 'node:path';
import type { ElementDescriptor, ElementKind, ModuleDescriptor, SourceFileRef } from '../types.js';
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
  { id: 'plugins', name: 'Plugins', dirName: 'plugins', elementKind: 'file' },
  { id: 'utils', name: 'Utils', dirName: 'utils', elementKind: 'file' },
];

/** Nuxt 4's official directory for code shared between app/ and server/; lives at the project root, not under appRoot. */
export const SHARED_CATEGORY: CategoryDef = { id: 'shared', name: 'Shared', dirName: 'shared', elementKind: 'file' };

const APP_ROOT_FILENAMES = ['app.vue', 'error.vue', 'app.config.ts'];

export async function buildCategoryModule(
  category: CategoryDef,
  categoryRootAbsPath: string,
  projectRoot: string,
  exclude: string[],
  include: string[],
): Promise<ModuleDescriptor | null> {
  const files = await listFilesUnder(categoryRootAbsPath, exclude, include);
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

/**
 * Nuxt 4 app-root files (app.vue, error.vue, app.config.ts) live directly under appRoot, not inside
 * a directory of their own — so buildCategoryModule's whole-directory glob doesn't fit. There are only
 * three known filenames, so a handful of fs.stat calls is simpler and lower-risk than a glob here.
 */
export async function buildAppRootModule(
  appRootAbsPath: string,
  projectRoot: string,
): Promise<ModuleDescriptor | null> {
  const files: SourceFileRef[] = [];
  const elements: ElementDescriptor[] = [];

  for (const filename of APP_ROOT_FILENAMES) {
    const absPath = path.join(appRootAbsPath, filename);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      continue; // file not present
    }
    if (!stat.isFile()) continue;

    const file: SourceFileRef = { absPath, relPath: filename, sizeBytes: stat.size };
    files.push(file);
    elements.push({ id: filename, kind: 'file', name: filename, files: [file] });
  }

  if (elements.length === 0) return null;

  return {
    id: 'app-root',
    name: 'App Root',
    rootPath: appRootAbsPath,
    relRootPath: toPosixPath(path.relative(projectRoot, appRootAbsPath)),
    framework: 'nuxt4',
    elements,
    relations: [],
    files,
  };
}
