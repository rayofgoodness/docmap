import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nuxt4Adapter } from '../../src/adapters/nuxt4/index.js';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/nuxt4-fake');
const GENERIC_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generic-fake');

function makeContext(projectRoot = FIXTURE_ROOT): DiscoveryContext {
  return { projectRoot, config: getDefaultConfig(), logger: createLogger() };
}

describe('nuxt4Adapter', () => {
  it('detects a project with nuxt.config.ts', async () => {
    await expect(nuxt4Adapter.detect(makeContext())).resolves.toBe(true);
  });

  it('does not detect a plain generic project', async () => {
    await expect(nuxt4Adapter.detect(makeContext(GENERIC_FIXTURE_ROOT))).resolves.toBe(false);
  });

  it('discovers one module per present category plus server', async () => {
    const modules = await nuxt4Adapter.discoverModules(makeContext());
    const ids = modules.map((m) => m.id).sort();
    expect(ids).toEqual([
      'app-root',
      'components',
      'composables',
      'layer_layers_base',
      'pages',
      'plugins',
      'server',
      'shared',
      'stores',
      'utils',
    ]);
  });

  it('discovers a layer module for layers/base even though it is not in nuxt.config.ts extends', async () => {
    // layers/base isn't listed under `extends` in the fixture's nuxt.config.ts — Nuxt 4
    // auto-registers every subdirectory of layers/ as a layer regardless, so discovery must too.
    const modules = await nuxt4Adapter.discoverModules(makeContext());
    const layerBase = modules.find((m) => m.id === 'layer_layers_base');
    expect(layerBase).toBeDefined();
    expect(layerBase?.relRootPath).toBe('layers/base');
    expect(layerBase?.elements.map((e) => e.name).sort()).toEqual(['checkout.ts', 'checkout.vue']);
  });

  it('discovers plugins and utils modules with kind "file" elements', async () => {
    const modules = await nuxt4Adapter.discoverModules(makeContext());
    const plugins = modules.find((m) => m.id === 'plugins')!;
    const utils = modules.find((m) => m.id === 'utils')!;
    expect(plugins.elements.map((e) => e.name)).toEqual(['analytics.client.ts']);
    expect(plugins.elements[0]?.kind).toBe('file');
    expect(utils.elements.map((e) => e.name)).toEqual(['formatDate.ts']);
    expect(utils.elements[0]?.kind).toBe('file');
  });

  it('discovers an app-root module containing app.vue', async () => {
    const modules = await nuxt4Adapter.discoverModules(makeContext());
    const appRoot = modules.find((m) => m.id === 'app-root')!;
    expect(appRoot.name).toBe('App Root');
    expect(appRoot.elements.map((e) => e.name)).toEqual(['app.vue']);
    expect(appRoot.elements[0]?.kind).toBe('file');
  });

  it('discovers a shared module containing currency.ts', async () => {
    const modules = await nuxt4Adapter.discoverModules(makeContext());
    const shared = modules.find((m) => m.id === 'shared')!;
    expect(shared.elements.map((e) => e.name)).toEqual(['currency.ts']);
    expect(shared.elements[0]?.kind).toBe('file');
  });

  it('derives Nitro route paths for server elements', async () => {
    const modules = await nuxt4Adapter.discoverModules(makeContext());
    const server = modules.find((m) => m.id === 'server')!;
    expect(server.elements[0]?.summaryHints).toEqual(['/api/cart']);
  });

  it('resolves import, api-call, and store-usage relations for the page', async () => {
    const { modules } = await discoverProject(makeContext());
    const pages = modules.find((m) => m.id === 'pages')!;

    const types = pages.relations.map((r) => `${r.type}->${r.toModule}`).sort();
    expect(types).toEqual(['api-call->server', 'import->components', 'import->composables', 'store->stores']);

    const apiCall = pages.relations.find((r) => r.type === 'api-call');
    expect(apiCall?.detail).toBe('/api/cart');
    expect(apiCall?.confidence).toBe('heuristic');
  });

  it('prefers the explicit import over a redundant store-call relation for the same store', async () => {
    // CartBadge.vue both `import`s useCartStore and calls it — the call adds no signal
    // beyond what the import already recorded, so it must not appear a second time.
    const { modules } = await discoverProject(makeContext());
    const components = modules.find((m) => m.id === 'components')!;
    const storeRelations = components.relations.filter((r) => r.toModule === 'stores');
    expect(storeRelations).toHaveLength(1);
    expect(storeRelations[0]).toMatchObject({ type: 'import', detail: '~/stores/cart' });
  });

  it('still records a store-call relation when the store has no explicit import (auto-import)', async () => {
    // cart.vue calls useCartStore() without importing it — Nuxt auto-imports the composable,
    // so the call site is the only signal available and dedup must not suppress it.
    const { modules } = await discoverProject(makeContext());
    const pages = modules.find((m) => m.id === 'pages')!;
    const storeRelation = pages.relations.find((r) => r.toModule === 'stores' && r.type === 'store');
    expect(storeRelation).toMatchObject({ detail: 'useCartStore()', confidence: 'heuristic' });
  });
});
