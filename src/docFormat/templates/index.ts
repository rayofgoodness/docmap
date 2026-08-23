import type { ModuleDescriptor, RelationDescriptor } from '../../adapters/types.js';
import { buildMermaidGraph, buildUserFlows } from '../../core/relationshipGraph.js';
import type { DependentEntry } from '../../core/discovery.js';

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

/** Maps every cross-stack relation's fully-qualified `toId` (e.g.
 * `peer:backend::vendor_sales::etc/webapi.xml`) to the same "<peerName> :: <backend module name>"
 * label the Integration surface table already renders via formatBackendOwner, so a peer node
 * appearing inside a Scenarios flow chain reads the same way it does there instead of as a raw id. */
function buildPeerNodeLabels(modules: ModuleDescriptor[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const rel of modules.flatMap((m) => m.relations)) {
    if (!isCrossStackRelation(rel)) continue;
    labels.set(rel.toId, formatBackendOwner(rel));
  }
  return labels;
}

/** A flow node is either a local `moduleId::elementId` (or bare `moduleId`) id — already
 * human-readable as-is, same convention the Modules/Relationships sections use — or a cross-stack
 * `peer:...` id, which gets the same readable treatment as the Integration surface table via
 * `peerLabels` (falling back to the raw id only if, unexpectedly, no cross-stack relation produced
 * a label for it). */
function formatFlowNode(nodeId: string, peerLabels: Map<string, string>): string {
  if (!nodeId.startsWith(PEER_RELATION_PREFIX)) return nodeId;
  return peerLabels.get(nodeId) ?? nodeId;
}

/**
 * Renders buildUserFlows' deterministic page->store->server->peer style chains as arrow-joined
 * bullet lines — a ready-made regression-test checklist ("here's exactly what happens when a user
 * clicks this button"). Small projects commonly have no relation chain 3+ nodes long (e.g. a page
 * that only imports a component), so this returns an empty array — contributing nothing to the
 * joined body — in that case, same "don't print an empty section" convention buildIntegrationSurfaceSection
 * already established above.
 */
function buildScenariosSection(modules: ModuleDescriptor[]): string[] {
  const flows = buildUserFlows(modules);
  if (flows.length === 0) return [];

  const peerLabels = buildPeerNodeLabels(modules);
  const lines = flows.map((flow) => `- ${flow.map((node) => formatFlowNode(node, peerLabels)).join(' → ')}`);

  return ['', '## Scenarios', '', ...lines];
}

/** When buildMermaidGraph caps the diagram to keep it readable, this renders the full edge list
 * it still returns as a labeled markdown table below the (now partial) mermaid block, so no
 * relation is silently dropped from index.md even though the picture only shows the top edges. */
function buildTruncationNote(graph: ReturnType<typeof buildMermaidGraph>): string[] {
  if (!graph.truncated) return [];
  return [
    '',
    `_Diagram capped to the top ${graph.shownEdges} of ${graph.totalEdges} edges (ranked by module connectivity) to stay readable. Full edge list:_`,
    '',
    graph.edgeTable,
  ];
}

export function buildIndexBody(modules: ModuleDescriptor[]): string {
  const rows = modules
    .map(
      (m) =>
        `| ${m.name} | ${m.framework} | ${m.relRootPath} | ${m.elements.length} | ${(m.metadata?.dependents as DependentEntry[] | undefined)?.length ?? 0} |`,
    )
    .join('\n');

  const graph = buildMermaidGraph(modules);

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
    graph.diagram,
    '```',
    ...buildTruncationNote(graph),
    ...buildScenariosSection(modules),
    ...buildIntegrationSurfaceSection(modules),
  ].join('\n');
}
