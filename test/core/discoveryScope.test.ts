import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/scope-fake');

function makeContext(configOverrides: Partial<ReturnType<typeof getDefaultConfig>> = {}): DiscoveryContext {
  return { projectRoot: FIXTURE_ROOT, config: { ...getDefaultConfig(), ...configOverrides }, logger: createLogger() };
}

describe('discoverProject respects the project .gitignore', () => {
  it('drops a gitignored file from its module without dropping the module', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleA = modules.find((m) => m.name === 'moduleA')!;
    const moduleB = modules.find((m) => m.name === 'moduleB')!;

    expect(moduleA.files.map((f) => f.relPath)).toEqual(['index.ts']);
    expect(moduleA.elements.map((e) => e.id)).toEqual(['index.ts']);
    expect(moduleB.files.map((f) => f.relPath)).toEqual(['helper.ts']);
  });
});

describe('discoverProject respects config.scanDir', () => {
  it('keeps only modules under the given subdirectory', async () => {
    const { modules } = await discoverProject(makeContext({ scanDir: 'moduleA' }));
    expect(modules.map((m) => m.name)).toEqual(['moduleA']);
  });

  it('is a no-op when scanDir resolves to the project root', async () => {
    const { modules } = await discoverProject(makeContext({ scanDir: '.' }));
    expect(modules.map((m) => m.name).sort()).toEqual(['moduleA', 'moduleB']);
  });
});
