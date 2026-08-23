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
}

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
      if (!target || !moduleIds.has(target) || target === module.id) continue;
      const edgeKey = `${module.id}->${target}:${rel.type}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      edges.push({ from: module.id, to: target, type: rel.type, confidence: rel.confidence });
    }
  }

  const totalEdges = edges.length;
  const truncated = totalEdges > MAX_DIAGRAM_EDGES;
  const diagramEdges = truncated ? selectTopEdges(edges, MAX_DIAGRAM_EDGES) : edges;

  const lines = ['graph LR'];
  for (const module of modules) {
    lines.push(`  ${mermaidId(module.id)}["${module.name}"]`);
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
