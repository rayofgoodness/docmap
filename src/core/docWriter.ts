import fs from 'node:fs/promises';
import path from 'node:path';
import type { ElementDescriptor, ModuleDescriptor } from '../adapters/types.js';
import {
  ElementFrontmatterSchema,
  IndexFrontmatterSchema,
  ModuleFrontmatterSchema,
  type ElementFrontmatter,
  type IndexFrontmatter,
  type ModuleFrontmatter,
} from '../docFormat/frontmatter.js';
import { parseDoc, tryParseDoc } from '../docFormat/parse.js';
import { renderDoc } from '../docFormat/render.js';
import { safeJoin } from '../utils/fsSafe.js';

export const DOCMAP_DIR = '.docmap';

export function slugifyElementId(id: string): string {
  return id.replace(/[\\/]+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function getDocmapRoot(projectRoot: string): string {
  return path.join(projectRoot, DOCMAP_DIR);
}

export function getModuleDocPath(projectRoot: string, module: Pick<ModuleDescriptor, 'relRootPath'>): string {
  return safeJoin(getDocmapRoot(projectRoot), path.join(module.relRootPath, 'README.md'));
}

export function getElementDocPath(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
  element: Pick<ElementDescriptor, 'id'>,
): string {
  return safeJoin(
    getDocmapRoot(projectRoot),
    path.join(module.relRootPath, `${slugifyElementId(element.id)}.md`),
  );
}

export function getIndexDocPath(projectRoot: string): string {
  return path.join(getDocmapRoot(projectRoot), 'index.md');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function writeModuleDoc(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
  frontmatter: ModuleFrontmatter,
  body: string,
): Promise<void> {
  await atomicWrite(getModuleDocPath(projectRoot, module), renderDoc(frontmatter, body));
}

export async function writeElementDoc(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
  element: Pick<ElementDescriptor, 'id'>,
  frontmatter: ElementFrontmatter,
  body: string,
): Promise<void> {
  await atomicWrite(getElementDocPath(projectRoot, module, element), renderDoc(frontmatter, body));
}

export async function writeIndexDoc(
  projectRoot: string,
  frontmatter: IndexFrontmatter,
  body: string,
): Promise<void> {
  await atomicWrite(getIndexDocPath(projectRoot), renderDoc(frontmatter, body));
}

export async function readModuleDoc(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
): Promise<{ frontmatter: ModuleFrontmatter; body: string } | null> {
  try {
    const raw = await fs.readFile(getModuleDocPath(projectRoot, module), 'utf8');
    return tryParseDoc(ModuleFrontmatterSchema, raw);
  } catch {
    return null;
  }
}

export { ElementFrontmatterSchema, IndexFrontmatterSchema, ModuleFrontmatterSchema, parseDoc };
