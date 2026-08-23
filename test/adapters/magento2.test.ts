import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { magento2Adapter } from '../../src/adapters/magento2/index.js';
import { detectMagento2 } from '../../src/adapters/magento2/detect.js';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/magento2-fake');
const GENERIC_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generic-fake');

function makeContext(projectRoot = FIXTURE_ROOT): DiscoveryContext {
  return { projectRoot, config: getDefaultConfig(), logger: createLogger() };
}

describe('magento2Adapter', () => {
  it('detects via composer.json requiring magento/framework', async () => {
    await expect(magento2Adapter.detect(makeContext())).resolves.toBe(true);
  });

  it('does not detect a plain generic project', async () => {
    await expect(magento2Adapter.detect(makeContext(GENERIC_FIXTURE_ROOT))).resolves.toBe(false);
  });

  it.each([
    'magento/product-community-edition',
    'magento/product-enterprise-edition',
    'magento/magento-cloud-metapackage',
    'mage-os/product-community-edition',
  ])('detects via composer.json requiring %s with no app/etc/env.php present', async (packageName) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magento2-detect-'));
    try {
      await fs.writeFile(
        path.join(tmpRoot, 'composer.json'),
        JSON.stringify({ name: 'vendor/adobe-commerce-fake', require: { [packageName]: '1.0.0' } }),
      );
      await expect(detectMagento2(tmpRoot)).resolves.toBe(true);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('discovers both modules by their declared module.xml name', async () => {
    const modules = await magento2Adapter.discoverModules(makeContext());
    const names = modules.map((m) => m.name).sort();
    expect(names).toEqual(['Vendor_ModuleOne', 'Vendor_ModuleTwo']);
  });

  it('classifies elements by their top-level directory', async () => {
    const modules = await magento2Adapter.discoverModules(makeContext());
    const moduleOne = modules.find((m) => m.name === 'Vendor_ModuleOne')!;
    const kinds = moduleOne.elements.map((e) => e.kind).sort();
    expect(kinds).toEqual(['model', 'observer', 'plugin']);
  });

  it('resolves deterministic di.xml preference and plugin relations across modules', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleOne = modules.find((m) => m.name === 'Vendor_ModuleOne')!;
    const moduleTwoId = modules.find((m) => m.name === 'Vendor_ModuleTwo')!.id;

    const preference = moduleOne.relations.find((r) => r.type === 'di');
    expect(preference).toMatchObject({
      toModule: moduleTwoId,
      toId: `${moduleTwoId}::Api/FooInterface.php`,
      confidence: 'deterministic',
    });

    const plugin = moduleOne.relations.find((r) => r.type === 'plugin-intercepts');
    expect(plugin).toMatchObject({
      toModule: moduleTwoId,
      toId: `${moduleTwoId}::Controller/Index/Index.php`,
      confidence: 'deterministic',
    });
  });

  it('resolves a deterministic events.xml observer binding', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleOne = modules.find((m) => m.name === 'Vendor_ModuleOne')!;
    const event = moduleOne.relations.find((r) => r.type === 'event');
    expect(event).toMatchObject({
      toId: 'checkout_cart_add_product_complete',
      confidence: 'deterministic',
    });
  });

  it('resolves heuristic cross-module relations from PHP use statements', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleOne = modules.find((m) => m.name === 'Vendor_ModuleOne')!;
    const heuristicImports = moduleOne.relations.filter((r) => r.type === 'import' && r.confidence === 'heuristic');
    expect(heuristicImports.length).toBeGreaterThanOrEqual(2);
  });
});
