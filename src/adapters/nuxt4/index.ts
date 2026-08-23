import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { DiscoveryContext, FrameworkAdapter, ModuleDescriptor, RelationDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { findExtendsLayers, findNuxtConfigPath, resolveAppRoot } from './detect.js';
import { APP_CATEGORIES, SHARED_CATEGORY, buildAppRootModule, buildCategoryModule } from './categories.js';
import { buildServerModule } from './serverRoutes.js';
import { resolveNuxt4Relations } from './relations.js';
import { listFilesUnder } from './scan.js';

/** Normalizes a layer path (e.g. './layers/base') to a canonical relative form for dedup. */
function normalizeLayerPath(layerRelPath: string): string {
  return toPosixPath(path.normalize(layerRelPath)).replace(/\/$/, '');
}

/**
 * Nuxt 4 auto-registers every immediate subdirectory of `<projectRoot>/layers/` as a layer,
 * without requiring an `extends` entry in nuxt.config. Lists those subdirectories (if the
 * layers/ directory exists at all).
 */
async function findAutoLayers(projectRoot: string): Promise<string[]> {
  const layersDir = path.join(projectRoot, 'layers');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(layersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => `layers/${entry.name}`);
}

async function buildLayerModule(
  layerRelPath: string,
  projectRoot: string,
  exclude: string[],
  include: string[],
): Promise<ModuleDescriptor | null> {
  const rootPath = path.resolve(projectRoot, layerRelPath);
  const files = await listFilesUnder(rootPath, exclude, include);
  if (files.length === 0) return null;

  return {
    id: `layer_${layerRelPath.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    name: `Layer: ${layerRelPath}`,
    rootPath,
    relRootPath: toPosixPath(path.relative(projectRoot, rootPath)),
    framework: 'nuxt4',
    elements: files.map((f) => ({ id: f.relPath, kind: 'file' as const, name: path.basename(f.relPath), files: [f] })),
    relations: [],
    files,
  };
}

export const nuxt4Adapter: FrameworkAdapter = {
  name: 'nuxt4',

  async detect(ctx: DiscoveryContext): Promise<boolean> {
    return (await findNuxtConfigPath(ctx.projectRoot)) !== null;
  },

  async discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]> {
    const { projectRoot, config } = ctx;
    const appRoot = await resolveAppRoot(projectRoot);
    const modules: ModuleDescriptor[] = [];

    for (const category of APP_CATEGORIES) {
      const module = await buildCategoryModule(
        category,
        path.join(appRoot, category.dirName),
        projectRoot,
        config.exclude,
        config.include,
      );
      if (module) modules.push(module);
    }

    const appRootModule = await buildAppRootModule(appRoot, projectRoot);
    if (appRootModule) modules.push(appRootModule);

    const serverModule = await buildServerModule(
      path.join(projectRoot, 'server'),
      projectRoot,
      config.exclude,
      config.include,
    );
    if (serverModule) modules.push(serverModule);

    // shared/ is Nuxt 4's official directory for code shared between app/ and server/, so it lives
    // at the project root rather than under appRoot.
    const sharedModule = await buildCategoryModule(
      SHARED_CATEGORY,
      path.join(projectRoot, 'shared'),
      projectRoot,
      config.exclude,
      config.include,
    );
    if (sharedModule) modules.push(sharedModule);

    const layerPaths = new Map<string, string>(); // normalized path -> original relative path

    const configPath = await findNuxtConfigPath(projectRoot);
    if (configPath) {
      const configSource = await fs.readFile(configPath, 'utf8');
      for (const layer of findExtendsLayers(configSource)) {
        layerPaths.set(normalizeLayerPath(layer), layer);
      }
    }

    // Nuxt 4 auto-registers every subdirectory of layers/ as a layer, without needing an
    // explicit extends entry in nuxt.config — so discover those alongside whatever extends lists.
    // A layer that's both auto-registered and explicitly listed in extends must not be added twice.
    for (const autoLayer of await findAutoLayers(projectRoot)) {
      const normalized = normalizeLayerPath(autoLayer);
      if (!layerPaths.has(normalized)) layerPaths.set(normalized, autoLayer);
    }

    for (const layer of layerPaths.values()) {
      const layerModule = await buildLayerModule(layer, projectRoot, config.exclude, config.include);
      if (layerModule) modules.push(layerModule);
    }

    return modules;
  },

  async resolveRelations(modules: ModuleDescriptor[], ctx: DiscoveryContext): Promise<RelationDescriptor[]> {
    const appRoot = await resolveAppRoot(ctx.projectRoot);
    const relations = await resolveNuxt4Relations(modules, appRoot, ctx.projectRoot);
    ctx.logger.debug(`nuxt4 adapter: resolved ${relations.length} cross-module relations`);
    return relations;
  },
};
