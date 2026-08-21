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
    expect(ids).toEqual(['components', 'composables', 'pages', 'server', 'stores']);
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
    expect(types).toEqual(['api-call->server', 'import->components', 'import->composables', 'unknown->stores']);

    const apiCall = pages.relations.find((r) => r.type === 'api-call');
    expect(apiCall?.detail).toBe('/api/cart');
    expect(apiCall?.confidence).toBe('heuristic');
  });
});
