import path from 'node:path';
import type { DiscoveryContext, FrameworkAdapter, ModuleDescriptor, RelationDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { detectMagento2, findModuleDirs } from './detect.js';
import { readModuleName } from './moduleXml.js';
import { collectModuleElements } from './elements.js';
import { buildNamespaceMap } from './namespace.js';
import { resolveMagento2XmlRelations } from './di.js';
import { resolvePhpUseRelations } from './phpImports.js';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export const magento2Adapter: FrameworkAdapter = {
  name: 'magento2',

  async detect(ctx: DiscoveryContext): Promise<boolean> {
    return detectMagento2(ctx.projectRoot);
  },

  async discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]> {
    const { projectRoot, config } = ctx;
    const moduleDirs = await findModuleDirs(projectRoot, config.exclude);
    const modules: ModuleDescriptor[] = [];

    for (const dir of moduleDirs) {
      const declaredName = await readModuleName(dir.absPath);
      const parentDirName = path.basename(path.dirname(dir.absPath));
      const ownDirName = path.basename(dir.absPath);
      const magentoModuleName = declaredName ?? `${parentDirName}_${ownDirName}`;

      const { elements, files } = await collectModuleElements(dir.absPath, config.exclude, config.include);

      modules.push({
        id: slugify(magentoModuleName),
        name: magentoModuleName,
        rootPath: dir.absPath,
        relRootPath: toPosixPath(dir.relPath),
        framework: 'magento2',
        elements,
        relations: [],
        files,
        metadata: { magentoModuleName },
      });
    }

    return modules;
  },

  async resolveRelations(modules: ModuleDescriptor[], ctx: DiscoveryContext): Promise<RelationDescriptor[]> {
    const nsMap = buildNamespaceMap(modules);
    const relations = [
      ...(await resolveMagento2XmlRelations(modules, nsMap)),
      ...(await resolvePhpUseRelations(modules, nsMap)),
    ];
    ctx.logger.debug(`magento2 adapter: resolved ${relations.length} cross-module relations`);
    return relations;
  },
};
