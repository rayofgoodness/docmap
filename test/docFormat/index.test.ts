import { describe, expect, it } from 'vitest';
import { buildIndexBody } from '../../src/docFormat/templates/index.js';
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
});
