import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nestjsAdapter } from '../../src/adapters/nestjs/index.js';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/nestjs-fake');
const GENERIC_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generic-fake');

function makeContext(projectRoot = FIXTURE_ROOT): DiscoveryContext {
  return { projectRoot, config: getDefaultConfig(), logger: createLogger() };
}

describe('nestjsAdapter', () => {
  it('detects via @nestjs/core in package.json', async () => {
    await expect(nestjsAdapter.detect(makeContext())).resolves.toBe(true);
  });

  it('does not detect a plain project', async () => {
    await expect(nestjsAdapter.detect(makeContext(GENERIC_FIXTURE_ROOT))).resolves.toBe(false);
  });

  it('finds one module per *.module.ts, named after its class', async () => {
    const modules = await nestjsAdapter.discoverModules(makeContext());
    const byName = Object.fromEntries(modules.map((m) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(['AppModule', 'AvailabilityModule', 'CustomersModule']);
    expect(byName.AppModule!.relRootPath).toBe('src');
    expect(byName.AvailabilityModule!.relRootPath).toBe('src/availability');
  });

  it('claims a nested feature module for itself, not its parent container', async () => {
    const modules = await nestjsAdapter.discoverModules(makeContext());
    const app = modules.find((m) => m.name === 'AppModule')!;
    expect(app.elements.map((e) => e.id).sort()).toEqual(['app.module.ts', 'main.ts']);
  });

  it('keeps a nested subfolder (dto/) attached to its owning feature module', async () => {
    const modules = await nestjsAdapter.discoverModules(makeContext());
    const availability = modules.find((m) => m.name === 'AvailabilityModule')!;
    expect(availability.elements.map((e) => e.id).sort()).toEqual([
      'availability.controller.ts',
      'availability.module.ts',
      'availability.service.ts',
      'dto/update-availability.dto.ts',
    ]);
  });

  it('classifies elements by their filename suffix', async () => {
    const modules = await nestjsAdapter.discoverModules(makeContext());
    const availability = modules.find((m) => m.name === 'AvailabilityModule')!;
    const kindOf = Object.fromEntries(availability.elements.map((e) => [e.id, e.kind]));
    expect(kindOf['availability.controller.ts']).toBe('controller');
    expect(kindOf['availability.service.ts']).toBe('service');
    expect(kindOf['availability.module.ts']).toBe('module');
    expect(kindOf['dto/update-availability.dto.ts']).toBe('dto');
  });

  it('resolves deterministic relations from @Module({ imports: [...] })', async () => {
    const { modules } = await discoverProject(makeContext());
    const app = modules.find((m) => m.name === 'AppModule')!;
    const availability = modules.find((m) => m.name === 'AvailabilityModule')!;
    const customers = modules.find((m) => m.name === 'CustomersModule')!;

    expect(app.relations.map((r) => r.toModule).sort()).toEqual([availability.id, customers.id].sort());
    expect(app.relations.every((r) => r.type === 'di' && r.confidence === 'deterministic')).toBe(true);

    const availabilityToCustomers = availability.relations.find((r) => r.toModule === customers.id);
    expect(availabilityToCustomers).toMatchObject({ type: 'di', confidence: 'deterministic' });
  });
});
