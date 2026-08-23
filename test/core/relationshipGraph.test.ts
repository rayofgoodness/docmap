import { describe, expect, it } from 'vitest';
import { buildMermaidGraph, buildUserFlows } from '../../src/core/relationshipGraph.js';
import type { ElementDescriptor, ModuleDescriptor, RelationDescriptor } from '../../src/adapters/types.js';

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

function makeElement(overrides: Partial<ElementDescriptor> & { id: string; kind: ElementDescriptor['kind'] }): ElementDescriptor {
  return {
    name: overrides.id,
    files: [],
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

  it('renders a cross-stack peer relation as a synthetic node instead of silently dropping it', () => {
    const relation = makeRelation({
      fromId: 'pages::CartPage',
      toId: 'peer:backend::vendor_sales::etc/webapi.xml',
      toModule: 'peer:backend::vendor_sales',
      toModuleName: 'Vendor_Sales',
      type: 'api-call',
      confidence: 'heuristic',
      detail: 'REST GET /V1/carts/mine -> Vendor_Sales',
    });
    const modules: ModuleDescriptor[] = [makeModule({ id: 'pages', name: 'Pages', relations: [relation] })];

    const result = buildMermaidGraph(modules);

    // The peer has no local module object, so it must be declared as its own node (labeled from
    // toModuleName, not the raw unreadable peer:<name>::<id> string) with a dashed edge to it.
    expect(result.diagram).toContain('["Vendor_Sales"]');
    expect(result.diagram).toMatch(/pages -\.->\|api-call\| \S*peer\S*/);
    expect(result.totalEdges).toBe(1);
    expect(result.shownEdges).toBe(1);
  });

  it('labels a peer node from the raw peer id when toModuleName is absent', () => {
    const relation = makeRelation({
      fromId: 'pages::CartPage',
      toId: 'peer:backend::vendor_sales',
      toModule: 'peer:backend::vendor_sales',
      type: 'api-call',
      confidence: 'heuristic',
    });
    const modules: ModuleDescriptor[] = [makeModule({ id: 'pages', name: 'Pages', relations: [relation] })];

    const result = buildMermaidGraph(modules);

    expect(result.diagram).toContain('["backend::vendor_sales"]');
  });
});

describe('buildUserFlows', () => {
  it('finds a page -> store -> server-route -> peer chain as one 4-node flow, in order', () => {
    const pageToStore = makeRelation({
      type: 'store',
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      confidence: 'heuristic',
    });
    const storeToServer = makeRelation({
      type: 'api-call',
      fromId: 'stores::cartStore',
      toId: 'server::api/cart.get.ts',
      toModule: 'server',
      confidence: 'heuristic',
    });
    const serverToPeer = makeRelation({
      type: 'api-call',
      fromId: 'server::api/cart.get.ts',
      toId: 'peer:backend::vendor_sales::etc/webapi.xml',
      toModule: 'peer:backend::vendor_sales',
      operation: 'REST GET /V1/carts/mine',
      toModuleName: 'Vendor_Sales',
      confidence: 'heuristic',
    });

    const modules: ModuleDescriptor[] = [
      makeModule({
        id: 'pages',
        name: 'Pages',
        elements: [makeElement({ id: 'CartPage', kind: 'page' })],
        relations: [pageToStore],
      }),
      makeModule({
        id: 'stores',
        name: 'Stores',
        elements: [makeElement({ id: 'cartStore', kind: 'store' })],
        relations: [storeToServer],
      }),
      makeModule({
        id: 'server',
        name: 'Server',
        elements: [makeElement({ id: 'api/cart.get.ts', kind: 'server-route' })],
        relations: [serverToPeer],
      }),
    ];

    const flows = buildUserFlows(modules);

    expect(flows).toEqual([
      [
        'pages::CartPage',
        'stores::cartStore',
        'server::api/cart.get.ts',
        'peer:backend::vendor_sales::etc/webapi.xml',
      ],
    ]);
  });

  it('returns zero flows when no relation chain reaches 3 nodes', () => {
    const pageToStore = makeRelation({
      type: 'store',
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      confidence: 'heuristic',
    });

    const modules: ModuleDescriptor[] = [
      makeModule({
        id: 'pages',
        name: 'Pages',
        elements: [makeElement({ id: 'CartPage', kind: 'page' })],
        relations: [pageToStore],
      }),
      makeModule({ id: 'stores', name: 'Stores', elements: [makeElement({ id: 'cartStore', kind: 'store' })] }),
    ];

    expect(buildUserFlows(modules)).toEqual([]);
  });

  it('does not infinite-loop on a relation cycle and returns a bounded set of maximal paths', () => {
    // A(page) -> B -> C -> A (cycle back to the start) and B -> D (a second, non-cyclic branch),
    // so two distinct maximal simple paths exist: A->B->C (dead-ends because A is already visited)
    // and A->B->D (dead-ends because D has no outgoing edges).
    const modules: ModuleDescriptor[] = [
      makeModule({
        id: 'a',
        name: 'A',
        elements: [makeElement({ id: 'A', kind: 'page' })],
        relations: [makeRelation({ fromId: 'a::A', toId: 'b::B', toModule: 'b' })],
      }),
      makeModule({
        id: 'b',
        name: 'B',
        elements: [makeElement({ id: 'B', kind: 'component' })],
        relations: [
          makeRelation({ fromId: 'b::B', toId: 'c::C', toModule: 'c' }),
          makeRelation({ fromId: 'b::B', toId: 'd::D', toModule: 'd' }),
        ],
      }),
      makeModule({
        id: 'c',
        name: 'C',
        elements: [makeElement({ id: 'C', kind: 'component' })],
        relations: [makeRelation({ fromId: 'c::C', toId: 'a::A', toModule: 'a' })],
      }),
      makeModule({
        id: 'd',
        name: 'D',
        elements: [makeElement({ id: 'D', kind: 'component' })],
      }),
    ];

    const flows = buildUserFlows(modules);

    expect(Array.isArray(flows)).toBe(true);
    expect(flows.length).toBe(2);
    expect(flows).toContainEqual(['a::A', 'b::B', 'c::C']);
    expect(flows).toContainEqual(['a::A', 'b::B', 'd::D']);
  });
});
