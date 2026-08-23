import type { ModuleDescriptor, RelationDescriptor } from '../../adapters/types.js';
import { buildMermaidGraph } from '../../core/relationshipGraph.js';

const PEER_RELATION_PREFIX = 'peer:';

/** Cross-stack relations (task 4.2) tag their `toModule` as `peer:<name>::<moduleId>` — that
 * prefix is the sole marker for "crosses the project boundary", reused here rather than inventing
 * a second convention. */
function isCrossStackRelation(rel: RelationDescriptor): boolean {
  return rel.toModule?.startsWith(PEER_RELATION_PREFIX) ?? false;
}

/** Prefers the structured `operation` field crossStack.ts sets on peer `api-call` relations; falls
 * back to parsing the human-readable `detail` string only for a relation that reached this prefix
 * without one (shouldn't happen for current producers, but keeps the table from going blank). */
function formatEndpointOperation(rel: RelationDescriptor): string {
  return rel.operation ?? rel.detail?.split(' -> ')[0]?.trim() ?? rel.toId;
}

/** Strips the `peer:<name>::` prefix off `toModule` for readability, rendering "<peerName> ::
 * <backend module name>" — e.g. "backend :: Vendor_Backend". Prefers the structured
 * `toModuleName` field over the raw (often lowercased/slugged) module id. */
function formatBackendOwner(rel: RelationDescriptor): string {
  const toModule = rel.toModule ?? '';
  const withoutPrefix = toModule.startsWith(PEER_RELATION_PREFIX)
    ? toModule.slice(PEER_RELATION_PREFIX.length)
    : toModule;
  const separatorIndex = withoutPrefix.indexOf('::');
  const peerName = separatorIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, separatorIndex);
  const moduleLabel =
    rel.toModuleName ?? (separatorIndex === -1 ? '' : withoutPrefix.slice(separatorIndex + 2));
  return `${peerName} :: ${moduleLabel}`;
}

/**
 * A direct QA/impact-analysis table: "if Vendor_Sales changes, which frontend pages/stores call
 * it, and via which endpoint?" Reads relations from the same source buildMermaidGraph already
 * does (module.relations across all modules), filtered down to cross-stack ones. Returns an empty
 * array — contributing nothing to the joined body — when a project has no peers configured or no
 * relation matched one, so the common (no-peers) case stays byte-identical to the pre-existing
 * output rather than growing an empty "(none)" section.
 */
function buildIntegrationSurfaceSection(modules: ModuleDescriptor[]): string[] {
  const rows = modules
    .flatMap((m) => m.relations)
    .filter(isCrossStackRelation)
    .map((rel) => `| ${formatEndpointOperation(rel)} | ${rel.fromId} | ${formatBackendOwner(rel)} |`);

  if (rows.length === 0) return [];

  return [
    '',
    '## Integration surface',
    '',
    '| Endpoint/Operation | Frontend consumer | Backend owner |',
    '|---|---|---|',
    ...rows,
  ];
}

export function buildIndexBody(modules: ModuleDescriptor[]): string {
  const rows = modules
    .map(
      (m) =>
        `| ${m.name} | ${m.framework} | ${m.relRootPath} | ${m.elements.length} | ${(m.metadata?.dependents as unknown[] | undefined)?.length ?? 0} |`,
    )
    .join('\n');

  return [
    '## Modules',
    '',
    '| Module | Framework | Path | Elements | Used by |',
    '|---|---|---|---|---|',
    rows || '| _none_ | | | | |',
    '',
    '## Relationships',
    '',
    '```mermaid',
    buildMermaidGraph(modules),
    '```',
    ...buildIntegrationSurfaceSection(modules),
  ].join('\n');
}
