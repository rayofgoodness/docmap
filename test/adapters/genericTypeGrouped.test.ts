import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { genericAdapter } from '../../src/adapters/generic/index.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/generic-typegrouped-fake',
);

function makeContext(): DiscoveryContext {
  return { projectRoot: FIXTURE_ROOT, config: getDefaultConfig(), logger: createLogger() };
}

describe('genericAdapter: a type-grouped container (Controllers/Models/Policies) is not split by subdirectory', () => {
  it('keeps "app" as one module instead of scattering Booking across Controllers/Models/Policies "modules"', async () => {
    const modules = await genericAdapter.discoverModules(makeContext());
    expect(modules.map((m) => m.name)).toEqual(['app']);

    const app = modules[0]!;
    expect(app.elements.map((e) => e.id).sort()).toEqual([
      'Controllers/BookingController.php',
      'Models/Booking.php',
      'Policies/BookingPolicy.php',
    ]);
  });
});
