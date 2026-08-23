import type { DiscoveryContext, ModuleDescriptor, RelationDescriptor, RelationType } from '../adapters/types.js';
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

interface DependentEntry {
  module: string;
  type: RelationType;
}

/** Dedup key mirroring buildRelationSummary's style in promptBuilder.ts — same (fromModule, type)
 * pair recorded once, not once per element-level relation that produced it. */
function dependentKey(entry: DependentEntry): string {
  return `${entry.type}|${entry.module}`;
}

/**
 * Builds the reverse of .relations — "who depends on me" — onto each module's metadata.dependents,
 * once every forward relation (local, adapter-resolved, and cross-stack) has already been attached.
 * A relation whose toModule points at a peer (`peer:<name>::<id>`) has no local module object to
 * record against and is skipped: dependents only covers modules this scan actually discovered — a
 * peer's own dependents aren't visible here since the peer was only discovered read-only, not fully
 * documented.
 */
function attachDependentsIndex(modules: ModuleDescriptor[]): void {
  const seenByModuleId = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const relation of module.relations) {
      if (!relation.toModule) continue;
      const target = modules.find((m) => m.id === relation.toModule);
      if (!target) continue;

      const entry: DependentEntry = { module: relation.fromId.split('::')[0]!, type: relation.type };
      const key = dependentKey(entry);
      let seen = seenByModuleId.get(target.id);
      if (!seen) {
        seen = new Set();
        seenByModuleId.set(target.id, seen);
      }
      if (seen.has(key)) continue;
      seen.add(key);

      target.metadata ??= {};
      const dependents = (target.metadata.dependents as DependentEntry[] | undefined) ?? [];
      dependents.push(entry);
      target.metadata.dependents = dependents;
    }
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

  // Reverse index — "who depends on me" — built once every forward relation above is in place.
  attachDependentsIndex(modules);

  // A --dir restriction should make out-of-scope modules disappear entirely, not just show up empty —
  // that's the whole point of "only scan this folder". Gitignore/include filtering, by contrast, can
  // legitimately leave a module with 0 surviving elements without meaning the module itself is irrelevant.
  const resultModules = scope.scanDirPrefix
    ? modules.filter((m) => m.files.length > 0 || m.elements.length > 0)
    : modules;

  return { frameworkName: adapter.name, modules: resultModules, peers };
}
