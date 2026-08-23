import type { DiscoveryContext, ModuleDescriptor, RelationDescriptor } from '../adapters/types.js';
import { resolveAdapter } from '../adapters/registry.js';
import { loadScopeFilters, filterFilesInScope } from './scopeFilter.js';
import { discoverAllPeers, type PeerProject } from './peers.js';
import { resolveCrossStackRelations } from './crossStack.js';

export interface DiscoveryResult {
  frameworkName: string;
  modules: ModuleDescriptor[];
  peers: PeerProject[];
}

/** Pushes each relation onto its owning local module's .relations array, keyed off the `<moduleId>::<elementId>` fromId. */
function attachRelationsToModules(modules: ModuleDescriptor[], relations: RelationDescriptor[]): void {
  for (const relation of relations) {
    const [moduleId] = relation.fromId.split('::');
    const module = modules.find((m) => m.id === moduleId);
    if (module) module.relations.push(relation);
  }
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
  attachRelationsToModules(modules, relations);

  const peers = ctx.config.peers.length > 0
    ? await discoverAllPeers(ctx.config.peers, ctx.projectRoot, ctx.logger)
    : [];

  // Match this project's Nuxt REST/GraphQL call sites against each peer's declared API surface
  // (webapi.xml routes, schema.graphqls fields), turning "backend changed, frontend broke
  // silently" into a visible cross-project relation on the calling module.
  for (const peer of peers) {
    const crossStackRelations = await resolveCrossStackRelations(modules, peer);
    attachRelationsToModules(modules, crossStackRelations);
  }

  // A --dir restriction should make out-of-scope modules disappear entirely, not just show up empty —
  // that's the whole point of "only scan this folder". Gitignore/include filtering, by contrast, can
  // legitimately leave a module with 0 surviving elements without meaning the module itself is irrelevant.
  const resultModules = scope.scanDirPrefix
    ? modules.filter((m) => m.files.length > 0 || m.elements.length > 0)
    : modules;

  return { frameworkName: adapter.name, modules: resultModules, peers };
}
