import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import { resolveAdapter } from '../adapters/registry.js';
import { loadScopeFilters, filterFilesInScope } from './scopeFilter.js';
import { discoverAllPeers, type PeerProject } from './peers.js';

export interface DiscoveryResult {
  frameworkName: string;
  modules: ModuleDescriptor[];
  peers: PeerProject[];
}

export async function discoverProject(ctx: DiscoveryContext): Promise<DiscoveryResult> {
  const adapter = await resolveAdapter(ctx);
  const modules = await adapter.discoverModules(ctx);

  const scope = await loadScopeFilters(ctx.projectRoot, ctx.config.scanDir);
  for (const module of modules) {
    module.files = filterFilesInScope(module.files, ctx.projectRoot, scope);
    module.elements = module.elements
      .map((element) => ({ ...element, files: filterFilesInScope(element.files, ctx.projectRoot, scope) }))
      .filter((element) => element.files.length > 0);
  }

  const relations = adapter.resolveRelations ? await adapter.resolveRelations(modules, ctx) : [];
  for (const relation of relations) {
    const [moduleId] = relation.fromId.split('::');
    const module = modules.find((m) => m.id === moduleId);
    if (module) module.relations.push(relation);
  }

  const peers = ctx.config.peers.length > 0
    ? await discoverAllPeers(ctx.config.peers, ctx.projectRoot, ctx.logger)
    : [];

  // A --dir restriction should make out-of-scope modules disappear entirely, not just show up empty —
  // that's the whole point of "only scan this folder". Gitignore/include filtering, by contrast, can
  // legitimately leave a module with 0 surviving elements without meaning the module itself is irrelevant.
  const resultModules = scope.scanDirPrefix
    ? modules.filter((m) => m.files.length > 0 || m.elements.length > 0)
    : modules;

  return { frameworkName: adapter.name, modules: resultModules, peers };
}
