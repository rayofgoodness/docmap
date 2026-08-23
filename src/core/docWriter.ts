import fs from 'node:fs/promises';
import path from 'node:path';
import type { ElementDescriptor, ModuleDescriptor } from '../adapters/types.js';
import {
  BriefFrontmatterSchema,
  ElementFrontmatterSchema,
  IndexFrontmatterSchema,
  ModuleFrontmatterSchema,
  type BriefFrontmatter,
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

/**
 * Business briefs live under `.docmap/business/<module.relRootPath>.md` — a single file per module
 * (not a per-module directory with README.md, unlike the tech doc layout), mirroring the plan's literal
 * path.
 */
export function getBriefDocPath(projectRoot: string, module: Pick<ModuleDescriptor, 'relRootPath'>): string {
  return safeJoin(getDocmapRoot(projectRoot), path.join('business', `${module.relRootPath}.md`));
}

export function getModuleHistoryDir(projectRoot: string, module: Pick<ModuleDescriptor, 'relRootPath'>): string {
  return safeJoin(getDocmapRoot(projectRoot), path.join('.history', module.relRootPath));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Snapshots the CURRENT on-disk module doc into `.docmap/.history/<module>/<generated_at>.md` before it
 * gets overwritten — so a `generate` run that lands on top of a regression doesn't erase the last
 * last-known-good baseline. Must be called BEFORE `writeModuleDoc` overwrites the doc.
 *
 * - `historyKeep <= 0` disables history entirely (no-op, no `.history` directory is ever created).
 * - No current doc on disk (first-time generate) is also a no-op — nothing to snapshot.
 * - The snapshot filename is derived from the OLD doc's own `generated_at` (colons replaced with dashes
 *   for filesystem safety), falling back to `Date.now()` if the existing doc doesn't parse.
 * - After writing, older snapshots beyond `historyKeep` are rotated out (oldest first) — snapshot
 *   filenames are timestamp-derived, so a lexicographic sort is a chronological sort.
 */
export async function snapshotModuleDocHistory(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
  historyKeep: number,
): Promise<void> {
  if (historyKeep <= 0) return;

  const docPath = getModuleDocPath(projectRoot, module);
  let raw: string;
  try {
    raw = await fs.readFile(docPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const parsed = tryParseDoc(ModuleFrontmatterSchema, raw);
  const generatedAt = parsed?.frontmatter.generated_at ?? new Date().toISOString();
  const safeTimestamp = generatedAt.replace(/:/g, '-');

  const historyDir = getModuleHistoryDir(projectRoot, module);
  const snapshotPath = path.join(historyDir, `${safeTimestamp}.md`);
  await atomicWrite(snapshotPath, raw);

  const entries = (await fs.readdir(historyDir)).filter((f) => f.endsWith('.md')).sort();
  if (entries.length > historyKeep) {
    const toDelete = entries.slice(0, entries.length - historyKeep);
    await Promise.all(toDelete.map((f) => fs.unlink(path.join(historyDir, f))));
  }
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

export async function writeBriefDoc(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
  frontmatter: BriefFrontmatter,
  body: string,
): Promise<void> {
  await atomicWrite(getBriefDocPath(projectRoot, module), renderDoc(frontmatter, body));
}

export async function readBriefDoc(
  projectRoot: string,
  module: Pick<ModuleDescriptor, 'relRootPath'>,
): Promise<{ frontmatter: BriefFrontmatter; body: string } | null> {
  try {
    const raw = await fs.readFile(getBriefDocPath(projectRoot, module), 'utf8');
    return tryParseDoc(BriefFrontmatterSchema, raw);
  } catch {
    return null;
  }
}

export { BriefFrontmatterSchema, ElementFrontmatterSchema, IndexFrontmatterSchema, ModuleFrontmatterSchema, parseDoc };
