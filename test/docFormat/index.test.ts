import { describe, expect, it } from 'vitest';
import { buildIndexBody } from '../../src/docFormat/templates/index.js';
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

function makeElement(overrides: Partial<ElementDescriptor> & { id: string; kind: ElementDescriptor['kind'] }): ElementDescriptor {
  return {
    name: overrides.id,
    files: [],
    ...overrides,
  };
}

describe('buildIndexBody', () => {
  it('omits the Integration surface section entirely when relations are all local (no peer: prefix anywhere)', () => {
    const localRelation: RelationDescriptor = {
      type: 'import',
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      detail: 'imports cartStore',
      confidence: 'deterministic',
    };
    const modules: ModuleDescriptor[] = [
      makeModule({ id: 'pages', name: 'Pages', relations: [localRelation] }),
      makeModule({ id: 'stores', name: 'Stores' }),
    ];

    const body = buildIndexBody(modules);

    expect(body).toContain('| Module | Framework | Path | Elements | Used by |');
    expect(body).not.toContain('## Integration surface');
    expect(body).not.toContain('(none)');
  });

  it('adds an Integration surface table with the frontend consumer and backend owner for a peer-prefixed relation', () => {
    const crossStackRelation: RelationDescriptor = {
      type: 'api-call',
      fromId: 'pages::CartPage',
      toId: 'peer:backend::vendor_sales::etc/webapi.xml',
      toModule: 'peer:backend::vendor_sales',
      operation: 'REST GET /V1/carts/mine',
      toModuleName: 'Vendor_Sales',
      detail: 'REST GET /V1/carts/mine -> Vendor_Sales',
      confidence: 'heuristic',
    };
    const modules: ModuleDescriptor[] = [
      makeModule({ id: 'pages', name: 'Pages', relations: [crossStackRelation] }),
    ];

    const body = buildIndexBody(modules);

    expect(body).toContain('## Integration surface');
    expect(body).toContain('| Endpoint/Operation | Frontend consumer | Backend owner |');
    expect(body).toContain('| REST GET /V1/carts/mine | pages::CartPage | backend :: Vendor_Sales |');
  });

  it('falls back to parsing detail when operation/toModuleName are absent on a peer-prefixed relation', () => {
    const crossStackRelation: RelationDescriptor = {
      type: 'api-call',
      fromId: 'pages::CartPage',
      toId: 'peer:backend::vendor_sales::etc/webapi.xml',
      toModule: 'peer:backend::vendor_sales',
      detail: 'REST GET /V1/carts/mine -> Vendor_Sales',
      confidence: 'heuristic',
    };
    const modules: ModuleDescriptor[] = [
      makeModule({ id: 'pages', name: 'Pages', relations: [crossStackRelation] }),
    ];

    const body = buildIndexBody(modules);

    expect(body).toContain('| REST GET /V1/carts/mine | pages::CartPage | backend :: vendor_sales |');
  });

  it('leaves the no-relations body unchanged (still no Integration surface section)', () => {
    const modules: ModuleDescriptor[] = [makeModule({ id: 'pages', name: 'Pages' })];
    const body = buildIndexBody(modules);
    expect(body.endsWith('```')).toBe(true);
  });

  it('adds a Scenarios section with an arrow chain, using the same peer label as Integration surface, when a 3+ node flow exists', () => {
    const pageToStore = {
      type: 'store' as const,
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      confidence: 'heuristic' as const,
    };
    const storeToServer = {
      type: 'api-call' as const,
      fromId: 'stores::cartStore',
      toId: 'server::api/cart.get.ts',
      toModule: 'server',
      confidence: 'heuristic' as const,
    };
    const serverToPeer = {
      type: 'api-call' as const,
      fromId: 'server::api/cart.get.ts',
      toId: 'peer:backend::vendor_sales::etc/webapi.xml',
      toModule: 'peer:backend::vendor_sales',
      operation: 'REST GET /V1/carts/mine',
      toModuleName: 'Vendor_PeerModule',
      detail: 'REST GET /V1/carts/mine -> Vendor_PeerModule',
      confidence: 'heuristic' as const,
    };

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

    const body = buildIndexBody(modules);

    expect(body).toContain('## Scenarios');
    expect(body).toContain(
      '- pages::CartPage → stores::cartStore → server::api/cart.get.ts → backend :: Vendor_PeerModule',
    );
    // Scenarios comes after Relationships and before Integration surface.
    expect(body.indexOf('## Relationships')).toBeLessThan(body.indexOf('## Scenarios'));
    expect(body.indexOf('## Scenarios')).toBeLessThan(body.indexOf('## Integration surface'));
  });

  it('omits the Scenarios section when no relation chain reaches 3 nodes', () => {
    const pageToStore: RelationDescriptor = {
      type: 'store',
      fromId: 'pages::CartPage',
      toId: 'stores::cartStore',
      toModule: 'stores',
      confidence: 'heuristic',
    };
    const modules: ModuleDescriptor[] = [
      makeModule({
        id: 'pages',
        name: 'Pages',
        elements: [makeElement({ id: 'CartPage', kind: 'page' })],
        relations: [pageToStore],
      }),
      makeModule({ id: 'stores', name: 'Stores', elements: [makeElement({ id: 'cartStore', kind: 'store' })] }),
    ];

    const body = buildIndexBody(modules);

    expect(body).not.toContain('## Scenarios');
  });
});
