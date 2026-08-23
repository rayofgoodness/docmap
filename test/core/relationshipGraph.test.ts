import { describe, expect, it } from 'vitest';
import { buildMermaidGraph } from '../../src/core/relationshipGraph.js';
import type { ModuleDescriptor, RelationDescriptor } from '../../src/adapters/types.js';

function makeModule(overrides: Partial<ModuleDescriptor> & { id: string; name: string }): ModuleDescriptor {
  return {
    rootPath: `/repo/${overrides.id}`,
    relRootPath: overrides.id,
    framework: 'nuxt4',
    elements: [],
    relations: [],
    files: [],
    ...overrides,
  };
}

function makeRelation(overrides: Partial<RelationDescriptor> & { fromId: string; toId: string }): RelationDescriptor {
  return {
    type: 'import',
    confidence: 'deterministic',
    ...overrides,
  };
}

describe('buildMermaidGraph', () => {
  it('renders a deterministic relation with a solid arrow', () => {
    const relation = makeRelation({
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      type: 'import',
      confidence: 'deterministic',
    });
    const modules: ModuleDescriptor[] = [
      makeModule({ id: 'pages', name: 'Pages', relations: [relation] }),
      makeModule({ id: 'stores', name: 'Stores' }),
    ];

    const result = buildMermaidGraph(modules);

    expect(result.diagram).toContain('pages -->|import| stores');
    expect(result.diagram).not.toContain('-.->');
    expect(result.truncated).toBe(false);
    expect(result.totalEdges).toBe(1);
    expect(result.shownEdges).toBe(1);
    expect(result.edgeTable).toBe('');
  });

  it('renders a heuristic relation with a dashed arrow', () => {
    const relation = makeRelation({
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      type: 'route',
      confidence: 'heuristic',
    });
    const modules: ModuleDescriptor[] = [
      makeModule({ id: 'pages', name: 'Pages', relations: [relation] }),
      makeModule({ id: 'stores', name: 'Stores' }),
    ];

    const result = buildMermaidGraph(modules);

    expect(result.diagram).toContain('pages -.->|route| stores');
  });

  it('truncates the diagram past the edge threshold but keeps a complete edge table', () => {
    // 12 modules, each importing every other module (12*11 = 132 deduplicated edges), well past
    // the ~80-edge threshold — synthesizes the "large project" case without needing 25+ real
    // modules.
    const moduleCount = 12;
    const ids = Array.from({ length: moduleCount }, (_, i) => `m${i}`);
    const modules: ModuleDescriptor[] = ids.map((id) =>
      makeModule({
        id,
        name: id,
        relations: ids
          .filter((otherId) => otherId !== id)
          .map((otherId) =>
            makeRelation({
              fromId: id,
              toId: otherId,
              toModule: otherId,
              type: 'import',
              confidence: 'deterministic',
            }),
          ),
      }),
    );

    const result = buildMermaidGraph(modules);

    expect(result.totalEdges).toBe(moduleCount * (moduleCount - 1));
    expect(result.truncated).toBe(true);
    expect(result.shownEdges).toBeLessThan(result.totalEdges);

    // The diagram itself only contains the capped edge count.
    const diagramEdgeLines = result.diagram
      .split('\n')
      .filter((line) => line.includes('-->') || line.includes('-.->'));
    expect(diagramEdgeLines.length).toBe(result.shownEdges);

    // But every single edge still appears in the full text table underneath.
    expect(result.edgeTable).toContain('| From | Type | To | Confidence |');
    for (const id of ids) {
      for (const otherId of ids) {
        if (id === otherId) continue;
        expect(result.edgeTable).toContain(`| ${id} | import | ${otherId} | deterministic |`);
      }
    }
  });
});
