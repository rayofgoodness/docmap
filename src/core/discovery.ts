import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import { resolveAdapter } from '../adapters/registry.js';

export interface DiscoveryResult {
  frameworkName: string;
  modules: ModuleDescriptor[];
}

export async function discoverProject(ctx: DiscoveryContext): Promise<DiscoveryResult> {
  const adapter = await resolveAdapter(ctx);
  const modules = await adapter.discoverModules(ctx);

  const relations = adapter.resolveRelations ? await adapter.resolveRelations(modules, ctx) : [];
  for (const relation of relations) {
    const [moduleId] = relation.fromId.split('::');
    const module = modules.find((m) => m.id === moduleId);
    if (module) module.relations.push(relation);
  }

  return { frameworkName: adapter.name, modules };
}
