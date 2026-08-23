import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { vue3Adapter } from '../../src/adapters/vue3/index.js';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/vue3-fake');
const GENERIC_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generic-fake');

function makeContext(projectRoot = FIXTURE_ROOT): DiscoveryContext {
  return { projectRoot, config: getDefaultConfig(), logger: createLogger() };
}

describe('vue3Adapter', () => {
  it('detects via a non-2.x "vue" dependency in package.json', async () => {
    await expect(vue3Adapter.detect(makeContext())).resolves.toBe(true);
  });

  it('does not detect a plain project with no vue dependency', async () => {
    await expect(vue3Adapter.detect(makeContext(GENERIC_FIXTURE_ROOT))).resolves.toBe(false);
  });

  it('discovers one module per category, by whichever dirName exists', async () => {
    const modules = await vue3Adapter.discoverModules(makeContext());
    const names = modules.map((m) => m.id).sort();
    expect(names).toEqual(['components', 'composables', 'router', 'stores', 'views']);
  });

  it('classifies elements by category', async () => {
    const modules = await vue3Adapter.discoverModules(makeContext());
    const views = modules.find((m) => m.id === 'views')!;
    expect(views.elements.every((e) => e.kind === 'page')).toBe(true);
  });

  it('resolves a component import as a heuristic relation', async () => {
    const { modules } = await discoverProject(makeContext());
    const views = modules.find((m) => m.id === 'views')!;
    const importRelation = views.relations.find((r) => r.type === 'import');
    expect(importRelation).toMatchObject({ toModule: 'components', confidence: 'heuristic' });
  });

  it('prefers the explicit import over a redundant store-call relation for the same store', async () => {
    // TheHeader.vue both `import`s useCartStore and calls it — the call adds no signal
    // beyond what the import already recorded, so it must not appear a second time.
    const { modules } = await discoverProject(makeContext());
    const components = modules.find((m) => m.id === 'components')!;
    const storeRelations = components.relations.filter((r) => r.toModule === 'stores');
    expect(storeRelations).toHaveLength(1);
    expect(storeRelations[0]).toMatchObject({ type: 'import', detail: '../stores/cart' });
  });

  it('still records a store-call relation when the store has no explicit import (auto-import)', async () => {
    const { modules } = await discoverProject(makeContext());
    const views = modules.find((m) => m.id === 'views')!;
    const storeRelation = views.relations.find((r) => r.toModule === 'stores' && r.type === 'store');
    expect(storeRelation).toMatchObject({ detail: 'useCartStore()', confidence: 'heuristic' });
  });

  it('resolves both static and dynamic-import route components to their view', async () => {
    const { modules } = await discoverProject(makeContext());
    const router = modules.find((m) => m.id === 'router')!;
    const routeRelations = router.relations.filter((r) => r.type === 'route');
    expect(routeRelations).toHaveLength(2);
    expect(routeRelations.every((r) => r.toModule === 'views')).toBe(true);
  });

  it('matches a kebab-case defineStore id against its PascalCase auto-import call site', async () => {
    // stores/checkoutPayment.ts declares defineStore('checkout-payment', ...); CheckoutPaymentView.vue
    // calls useCheckoutPaymentStore() with no explicit import. Naive lowercasing alone would compare
    // "checkout-payment" against "checkoutpayment" and never match — both sides must also strip
    // the hyphen.
    const { modules } = await discoverProject(makeContext());
    const views = modules.find((m) => m.id === 'views')!;
    const storeRelation = views.relations.find(
      (r) => r.toModule === 'stores' && r.type === 'store' && r.detail === 'useCheckoutPaymentStore()',
    );
    expect(storeRelation).toMatchObject({ detail: 'useCheckoutPaymentStore()', confidence: 'heuristic' });
  });
});
