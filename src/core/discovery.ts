import type { DiscoveryContext, ModuleDescriptor, RelationDescriptor, RelationType } from '../adapters/types.js';
import { resolveAdapter } from '../adapters/registry.js';
import { loadScopeFilters, filterFilesInScope } from './scopeFilter.js';
import { discoverAllPeers, type PeerProject } from './peers.js';
import { extractConsumerCallSites, resolveCrossStackRelationsFromCallSites } from './crossStack.js';

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

/** The shape stored in `module.metadata.dependents` — exported so every consumer (promptBuilder.ts's
 * "Used by" summary, index.md's "Used by" column, orchestrator.ts's frontmatter) shares one precise
 * type instead of each independently re-casting an untyped `metadata` bag. */
export interface DependentEntry {
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
 *
 * `survivingIds` is the final (post `--dir`-filter) set of module ids that will actually be returned
 * from discoverProject — both the target AND the dependent itself must be in it, or the entry is
 * skipped. Without this, a `--dir`-scoped module could carry a "used by X" entry naming a module that
 * `--dir` dropped entirely (or vice versa), a dangling reference that then gets written into generated
 * frontmatter and injected into the LLM prompt naming a module that appears nowhere else in the output.
 */
function attachDependentsIndex(modules: ModuleDescriptor[], survivingIds: Set<string>): void {
  const seenByModuleId = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const relation of module.relations) {
      if (!relation.toModule) continue;
      const target = modules.find((m) => m.id === relation.toModule);
      if (!target || !survivingIds.has(target.id)) continue;

      const fromModuleId = relation.fromId.split('::')[0]!;
      if (!survivingIds.has(fromModuleId)) continue;

      const entry: DependentEntry = { module: fromModuleId, type: relation.type };
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

  // A --dir restriction should make out-of-scope modules disappear entirely, not just show up empty —
  // that's the whole point of "only scan this folder". Gitignore/include filtering, by contrast, can
  // legitimately leave a module with 0 surviving elements without meaning the module itself is
  // irrelevant. Computed here (before relation/dependents resolution, which still needs the full
  // `modules` list) purely so attachDependentsIndex below can avoid recording a dangling "used by"
  // reference to or from a module that won't be in the final output.
  const resultModules = scope.scanDirPrefix
    ? modules.filter((m) => m.files.length > 0 || m.elements.length > 0)
    : modules;
  const survivingIds = new Set(resultModules.map((m) => m.id));

  const relations = adapter.resolveRelations ? await adapter.resolveRelations(modules, ctx) : [];
  attachRelationsToModules(modules, relations);

  const peers = ctx.config.peers.length > 0
    ? await discoverAllPeers(ctx.config.peers, ctx.projectRoot, ctx.logger)
    : [];

  // Match this project's Nuxt REST/GraphQL call sites against each peer's declared API surface
  // (webapi.xml routes, schema.graphqls fields), turning "backend changed, frontend broke
  // silently" into a visible cross-project relation on the calling module. Consumer source is read
  // and extracted ONCE (not once per peer) and reused across every configured peer's (indexed) match.
  if (peers.length > 0) {
    const callSites = await extractConsumerCallSites(modules);
    for (const peer of peers) {
      const crossStackRelations = resolveCrossStackRelationsFromCallSites(callSites, peer);
      attachRelationsToModules(modules, crossStackRelations);
    }
  }

  // Reverse index — "who depends on me" — built once every forward relation above is in place.
  attachDependentsIndex(modules, survivingIds);

  return { frameworkName: adapter.name, modules: resultModules, peers };
}
