import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { genericAdapter } from '../../src/adapters/generic/index.js';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/generic-fake',
);

function makeContext(): DiscoveryContext {
  return { projectRoot: FIXTURE_ROOT, config: getDefaultConfig(), logger: createLogger() };
}

describe('genericAdapter', () => {
  it('always detects', async () => {
    await expect(genericAdapter.detect(makeContext())).resolves.toBe(true);
  });

  it('discovers one module per top-level directory', async () => {
    const modules = await genericAdapter.discoverModules(makeContext());
    const names = modules.map((m) => m.name).sort();
    expect(names).toEqual(['moduleA', 'moduleB']);
    for (const module of modules) {
      expect(module.framework).toBe('generic');
      expect(module.elements).toHaveLength(1);
    }
  });

  it('resolves a cross-module relative import as a heuristic relation', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleA = modules.find((m) => m.name === 'moduleA')!;
    expect(moduleA.relations).toHaveLength(1);
    expect(moduleA.relations[0]).toMatchObject({
      type: 'import',
      toModule: 'moduleb',
      confidence: 'heuristic',
    });
  });
});
