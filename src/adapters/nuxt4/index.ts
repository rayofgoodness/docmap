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

/**
 * Builds the structured modules living inside a Nuxt layer: one module per APP_CATEGORIES entry
 * (pages, components, composables, layouts, middleware, stores, plugins, utils) rooted at
 * `<layerRoot>/<category.dirName>`, plus a server module for `<layerRoot>/server` — mirroring the
 * exact category structure buildCategoryModule/buildServerModule produce at the app root, so a
 * layer's stores and server routes get proper element kinds and participate in relation matching
 * the same way root-level stores/server do. Module ids are namespaced `layer_<name>__<category>`
 * (e.g. `layer_base__stores`) to avoid colliding with the root-level `stores`/`server` module ids.
 *
 * Any files sitting directly under the layer root that aren't covered by a category or by server/
 * (e.g. a stray layer-level config file) fall back to a single flat "layer root" module, keeping
 * the old flat-module behavior for just the leftover files — most layers won't have any.
 */
async function buildLayerModules(
  layerRelPath: string,
  projectRoot: string,
  exclude: string[],
  include: string[],
): Promise<ModuleDescriptor[]> {
  const layerRoot = path.resolve(projectRoot, layerRelPath);
  const layerName = path.basename(toPosixPath(layerRelPath).replace(/\/$/, ''));
  const modules: ModuleDescriptor[] = [];
  const coveredDirNames = new Set<string>([...APP_CATEGORIES.map((c) => c.dirName), 'server']);

  for (const category of APP_CATEGORIES) {
    const module = await buildCategoryModule(
      { ...category, id: `layer_${layerName}__${category.id}`, name: `Layer ${layerName}: ${category.name}` },
      path.join(layerRoot, category.dirName),
      projectRoot,
      exclude,
      include,
    );
    if (module) modules.push(module);
  }

  const serverModule = await buildServerModule(
    path.join(layerRoot, 'server'),
    projectRoot,
    exclude,
    include,
    `layer_${layerName}__server`,
    `Layer ${layerName}: Server`,
  );
  if (serverModule) modules.push(serverModule);

  // Files directly under the layer root that no category/server module above already claimed —
  // this is the only case where the old flat "layer root" module still earns its keep.
  const allFiles = await listFilesUnder(layerRoot, exclude, include);
  const looseFiles = allFiles.filter((f) => !coveredDirNames.has(f.relPath.split('/')[0] ?? ''));
  if (looseFiles.length > 0) {
    modules.push({
      id: `layer_${layerRelPath.replace(/[^a-zA-Z0-9]+/g, '_')}`,
      name: `Layer: ${layerRelPath}`,
      rootPath: layerRoot,
      relRootPath: toPosixPath(path.relative(projectRoot, layerRoot)),
      framework: 'nuxt4',
      elements: looseFiles.map((f) => ({
        id: f.relPath,
        kind: 'file' as const,
        name: path.basename(f.relPath),
        files: [f],
      })),
      relations: [],
      files: looseFiles,
    });
  }

  return modules;
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
      const layerModules = await buildLayerModules(layer, projectRoot, config.exclude, config.include);
      modules.push(...layerModules);
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
