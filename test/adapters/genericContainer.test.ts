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
  '../fixtures/generic-container-fake',
);

function makeContext(): DiscoveryContext {
  return { projectRoot: FIXTURE_ROOT, config: getDefaultConfig(), logger: createLogger() };
}

describe('genericAdapter: container directories split into per-feature modules', () => {
  it('splits src/ (3+ subdirs) into one module per subdirectory, plus one for loose root files', async () => {
    const modules = await genericAdapter.discoverModules(makeContext());
    const names = modules.map((m) => m.name).sort();
    expect(names).toEqual(['src', 'src/availability', 'src/customers', 'src/users']);
  });

  it('keeps a nested subfolder (dto/) attached to its feature module instead of splitting further', async () => {
    const modules = await genericAdapter.discoverModules(makeContext());
    const availability = modules.find((m) => m.name === 'src/availability')!;
    expect(availability.elements.map((e) => e.id).sort()).toEqual([
      'availability.controller.ts',
      'availability.service.ts',
      'dto/update-availability.dto.ts',
    ]);
  });

  it('only holds bootstrap files directly in the container for the container-level module', async () => {
    const modules = await genericAdapter.discoverModules(makeContext());
    const src = modules.find((m) => m.name === 'src')!;
    expect(src.elements.map((e) => e.id).sort()).toEqual(['app.module.ts', 'main.ts']);
  });

  it('resolves a cross-submodule import to the specific submodule, not the parent container', async () => {
    const { modules } = await discoverProject(makeContext());
    const availability = modules.find((m) => m.name === 'src/availability')!;
    const customers = modules.find((m) => m.name === 'src/customers')!;

    const relation = availability.relations.find((r) => r.type === 'import');
    expect(relation).toMatchObject({ toModule: customers.id, confidence: 'heuristic' });
  });
});
