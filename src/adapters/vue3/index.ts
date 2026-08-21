import type { DiscoveryContext, FrameworkAdapter, ModuleDescriptor, RelationDescriptor } from '../types.js';
import { detectVue3, resolveAppRoot } from './detect.js';
import { APP_CATEGORIES, buildCategoryModule } from './categories.js';
import { resolveVue3Relations } from './relations.js';

export const vue3Adapter: FrameworkAdapter = {
  name: 'vue3',

  async detect(ctx: DiscoveryContext): Promise<boolean> {
    return detectVue3(ctx.projectRoot);
  },

  async discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]> {
    const { projectRoot, config } = ctx;
    const appRoot = await resolveAppRoot(projectRoot);
    const modules: ModuleDescriptor[] = [];

    for (const category of APP_CATEGORIES) {
      const module = await buildCategoryModule(category, appRoot, projectRoot, config.exclude, config.include);
      if (module) modules.push(module);
    }

    return modules;
  },

  async resolveRelations(modules: ModuleDescriptor[], ctx: DiscoveryContext): Promise<RelationDescriptor[]> {
    const appRoot = await resolveAppRoot(ctx.projectRoot);
    const relations = await resolveVue3Relations(modules, appRoot, ctx.projectRoot);
    ctx.logger.debug(`vue3 adapter: resolved ${relations.length} cross-module relations`);
    return relations;
  },
};
