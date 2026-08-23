import type { ModuleDescriptor, RelationConfidence } from '../adapters/types.js';

function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Above this many deduplicated edges, a mermaid `graph LR` becomes an unreadable "hairball" and
 * slow for mermaid to lay out. The plan frames ~25 modules as the size that's still readable at a
 * glance; at a handful of relations per module that lands in the ~75-100 edge range, so 80 is
 * picked as a threshold just past that natural ceiling — small/medium projects render in full,
 * larger ones get their diagram capped (with the full edge list still available as text below it).
 */
const MAX_DIAGRAM_EDGES = 80;

interface Edge {
  from: string;
  to: string;
  type: string;
  confidence: RelationConfidence;
  /** Display label for `to` when it's a peer node (`peer:<name>::<moduleId>`) — the id itself isn't
   * readable, so the diagram needs the relation's own toModuleName to label the synthetic peer node. */
  toLabel?: string;
}

const PEER_TARGET_PREFIX = 'peer:';

export interface MermaidGraphResult {
  /** The `graph LR ...` mermaid source (no surrounding ``` fence). */
  diagram: string;
  /** True when the diagram was capped to the top edges by module degree. */
  truncated: boolean;
  /** Total deduplicated edges found, before any capping. */
  totalEdges: number;
  /** Edges actually rendered in `diagram`. Equal to `totalEdges` unless `truncated`. */
  shownEdges: number;
  /**
   * Full "From | Type | To | Confidence" markdown table covering every deduplicated edge.
   * Populated only when `truncated` is true, so the underlying data is never silently dropped
   * even though the visual diagram is capped; empty string when not truncated, since in that
   * case the diagram already shows every edge.
   */
  edgeTable: string;
}

/** Ranks edges by the combined in+out degree of the modules they touch (higher first), so the
 * capped diagram keeps the edges around the most-connected modules rather than an arbitrary
 * prefix. Ties keep original discovery order for determinism. */
function selectTopEdges(edges: Edge[], limit: number): Edge[] {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  return edges
    .map((edge, index) => ({
      edge,
      index,
      score: (degree.get(edge.from) ?? 0) + (degree.get(edge.to) ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((scored) => scored.edge);
}

function buildEdgeTable(edges: Edge[]): string {
  const rows = edges.map((e) => `| ${e.from} | ${e.type} | ${e.to} | ${e.confidence} |`);
  return ['| From | Type | To | Confidence |', '|---|---|---|---|', ...rows].join('\n');
}

export function buildMermaidGraph(modules: ModuleDescriptor[]): MermaidGraphResult {
  const moduleIds = new Set(modules.map((m) => m.id));
  const seenEdges = new Set<string>();
  const edges: Edge[] = [];

  for (const module of modules) {
    for (const rel of module.relations) {
      const target = rel.toModule;
      if (!target || target === module.id) continue;
      const isPeer = target.startsWith(PEER_TARGET_PREFIX);
      // A peer target has no local module object (it's a sibling project, scanned read-only), so it's
      // never in `moduleIds` — that must not exclude it the way an unrelated/unknown local id would;
      // it gets a synthetic node instead, labeled from the relation's own toModuleName.
      if (!isPeer && !moduleIds.has(target)) continue;
      const edgeKey = `${module.id}->${target}:${rel.type}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      edges.push({
        from: module.id,
        to: target,
        type: rel.type,
        confidence: rel.confidence,
        toLabel: isPeer ? (rel.toModuleName ?? target.slice(PEER_TARGET_PREFIX.length)) : undefined,
      });
    }
  }

  const totalEdges = edges.length;
  const truncated = totalEdges > MAX_DIAGRAM_EDGES;
  const diagramEdges = truncated ? selectTopEdges(edges, MAX_DIAGRAM_EDGES) : edges;

  const lines = ['graph LR'];
  for (const module of modules) {
    lines.push(`  ${mermaidId(module.id)}["${module.name}"]`);
  }
  // Peer nodes are declared only for peer targets that actually survive into the rendered (possibly
  // truncated) edge set, so a capped diagram never declares a node with no visible edge to it.
  const declaredPeerNodes = new Set<string>();
  for (const edge of diagramEdges) {
    if (edge.toLabel !== undefined && !declaredPeerNodes.has(edge.to)) {
      declaredPeerNodes.add(edge.to);
      lines.push(`  ${mermaidId(edge.to)}["${edge.toLabel}"]`);
    }
  }
  for (const edge of diagramEdges) {
    const arrow = edge.confidence === 'heuristic' ? '-.->' : '-->';
    lines.push(`  ${mermaidId(edge.from)} ${arrow}|${edge.type}| ${mermaidId(edge.to)}`);
  }

  return {
    diagram: lines.join('\n'),
    truncated,
    totalEdges,
    shownEdges: diagramEdges.length,
    edgeTable: truncated ? buildEdgeTable(edges) : '',
  };
}

/**
 * Above this many collected flows, further DFS branches are abandoned even if not yet exhausted.
 * Mirrors MAX_DIAGRAM_EDGES's reasoning: a densely-connected project (many pages, each with several
 * branching relations) can have combinatorially many simple paths, and enumerating every one of
 * them isn't the point — a manager/QA reader skimming index.md wants a representative sample of
 * end-to-end routes to regression-test, not an exhaustive path enumeration. 50 is picked as a round
 * number comfortably above what a real project's "distinct user journeys" count usually looks like
 * (dozens, not hundreds) while still bounding worst-case work on adversarial/synthetic graphs. This
 * is a deliberate cap, not a claim that every possible page-rooted path is represented below it.
 */
const MAX_USER_FLOWS = 50;

/** Builds a `fromId -> [toId, ...]` adjacency list from every module's relations, deduplicated by
 * (from, to) pair regardless of relation type — buildUserFlows walks node-to-node, so two relations
 * of different types between the same pair of nodes should still only produce one graph edge. Skips
 * exact self-loops (fromId === toId) the same way buildMermaidGraph skips module-level self-loops. */
function buildFlowAdjacency(modules: ModuleDescriptor[]): Map<string, string[]> {
  const seenEdges = new Set<string>();
  const adjacency = new Map<string, string[]>();

  for (const module of modules) {
    for (const rel of module.relations) {
      const { fromId, toId } = rel;
      if (!fromId || !toId || fromId === toId) continue;
      const edgeKey = `${fromId}->${toId}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      const existing = adjacency.get(fromId);
      if (existing) existing.push(toId);
      else adjacency.set(fromId, [toId]);
    }
  }

  return adjacency;
}

/** DFS from `node`, extending `path` through unvisited neighbors only (simple-path/no-revisit —
 * this is what makes the walk cycle-safe without any separate cycle detection: a relation cycle
 * just means every neighbor of the last node is already in `visited`, so the branch dead-ends).
 * A path is recorded only when it can't be extended further (every neighbor already visited, or no
 * neighbors at all) and has at least 3 nodes — so a linear page->store->server->peer chain records
 * once, at its full length, rather than also recording its page->store->server prefix. */
function walkFlows(
  node: string,
  path: string[],
  visited: Set<string>,
  adjacency: Map<string, string[]>,
  flows: string[][],
): void {
  if (flows.length >= MAX_USER_FLOWS) return;

  const neighbors = adjacency.get(node) ?? [];
  const unvisited = neighbors.filter((n) => !visited.has(n));

  if (unvisited.length === 0) {
    if (path.length >= 3) flows.push([...path]);
    return;
  }

  for (const next of unvisited) {
    if (flows.length >= MAX_USER_FLOWS) return;
    visited.add(next);
    path.push(next);
    walkFlows(next, path, visited, adjacency, flows);
    path.pop();
    visited.delete(next);
  }
}

/**
 * Deterministic (no LLM) end-to-end route finder: starting from every `page` element, walks the
 * same module.relations data buildMermaidGraph reads, but at element granularity, following
 * `fromId -> toId` edges (already fully-qualified as `moduleId::elementId` by every current relation
 * producer — nuxt4/relations.ts and crossStack.ts both build `fromId` that way; `toId` is either the
 * same shape, a bare `moduleId` for a module-level `import` relation, or a `peer:<name>::<moduleId>
 * ::<elementId>` cross-stack id) to collect maximal simple paths of 3+ nodes: a "here's exactly what
 * happens when a user clicks this button" chain, e.g. a page that uses a store that calls a server
 * route that calls out to a peer backend module. Each returned path is ordered page-first.
 */
export function buildUserFlows(modules: ModuleDescriptor[]): string[][] {
  const adjacency = buildFlowAdjacency(modules);
  const flows: string[][] = [];

  for (const module of modules) {
    if (flows.length >= MAX_USER_FLOWS) break;
    for (const element of module.elements) {
      if (element.kind !== 'page') continue;
      if (flows.length >= MAX_USER_FLOWS) break;
      const start = `${module.id}::${element.id}`;
      walkFlows(start, [start], new Set([start]), adjacency, flows);
    }
  }

  return flows;
}
