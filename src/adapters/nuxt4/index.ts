import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryContext, FrameworkAdapter, ModuleDescriptor, RelationDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { findExtendsLayers, findNuxtConfigPath, resolveAppRoot } from './detect.js';
import { APP_CATEGORIES, buildCategoryModule } from './categories.js';
import { buildServerModule } from './serverRoutes.js';
import { resolveNuxt4Relations } from './relations.js';
import { listFilesUnder } from './scan.js';

async function buildLayerModule(
  layerRelPath: string,
  projectRoot: string,
  exclude: string[],
): Promise<ModuleDescriptor | null> {
  const rootPath = path.resolve(projectRoot, layerRelPath);
  const files = await listFilesUnder(rootPath, exclude);
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
      );
      if (module) modules.push(module);
    }

    const serverModule = await buildServerModule(path.join(projectRoot, 'server'), projectRoot, config.exclude);
    if (serverModule) modules.push(serverModule);

    const configPath = await findNuxtConfigPath(projectRoot);
    if (configPath) {
      const configSource = await fs.readFile(configPath, 'utf8');
      for (const layer of findExtendsLayers(configSource)) {
        const layerModule = await buildLayerModule(layer, projectRoot, config.exclude);
        if (layerModule) modules.push(layerModule);
      }
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
