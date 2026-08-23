import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { discoverProject } from '../../src/core/discovery.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/magento2-fake');

function makeContext(configOverrides: Partial<ReturnType<typeof getDefaultConfig>> = {}): DiscoveryContext {
  return {
    projectRoot: FIXTURE_ROOT,
    config: { ...getDefaultConfig(), ...configOverrides },
    logger: createLogger(),
  };
}

describe('discoverProject peers', () => {
  it('returns an empty peers array when no peers are configured', async () => {
    const { peers } = await discoverProject(makeContext());
    expect(peers).toEqual([]);
  });

  it('discovers a configured peer read-only via its own adapter and config', async () => {
    const { peers } = await discoverProject(
      makeContext({ peers: [{ name: 'backend', path: '../magento2-peer-fake' }] }),
    );

    expect(peers).toHaveLength(1);
    const [peer] = peers;
    expect(peer).toMatchObject({ peerName: 'backend', frameworkName: 'magento2' });
    expect(peer!.modules.length).toBeGreaterThan(0);
    expect(peer!.modules.map((m) => m.name)).toEqual(['Vendor_PeerModule']);
  });

  it('does not throw and returns an empty peers array when a peer path does not exist', async () => {
    const logger = createLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const result = await discoverProject({
      projectRoot: FIXTURE_ROOT,
      config: { ...getDefaultConfig(), peers: [{ name: 'missing', path: '../does-not-exist' }] },
      logger,
    });

    expect(result.peers).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });
});

describe('discoverProject reverse "used by" index', () => {
  it('records a dependent on the target module for a one-directional relation (moduleOne di.xml -> moduleTwo)', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleOne = modules.find((m) => m.name === 'Vendor_ModuleOne')!;
    const moduleTwo = modules.find((m) => m.name === 'Vendor_ModuleTwo')!;

    // moduleOne's di.xml preference points at moduleTwo — moduleTwo never declares anything back at
    // moduleOne, so this only shows up at all if the reverse index was built.
    expect(moduleOne.relations.some((r) => r.type === 'di' && r.toModule === moduleTwo.id)).toBe(true);
    expect(moduleTwo.metadata?.dependents).toContainEqual({ module: moduleOne.id, type: 'di' });

    // The forward direction must not have grown a reciprocal dependents entry.
    expect(moduleOne.metadata?.dependents ?? []).not.toContainEqual({ module: moduleTwo.id, type: 'di' });
  });

  it('deduplicates dependents to one (fromModule, type) entry even when many elements produce the same relation', async () => {
    const { modules } = await discoverProject(makeContext());
    const moduleOne = modules.find((m) => m.name === 'Vendor_ModuleOne')!;
    const moduleTwo = modules.find((m) => m.name === 'Vendor_ModuleTwo')!;

    const diDependentEntries = ((moduleTwo.metadata?.dependents as Array<{ module: string; type: string }>) ?? []).filter(
      (d) => d.module === moduleOne.id && d.type === 'di',
    );
    expect(diDependentEntries).toHaveLength(1);
  });

  it('never records a dependent naming a module that a --dir restriction scoped out of the result', async () => {
    // ModuleOne's di.xml points at ModuleTwo — without --dir both are discovered and ModuleTwo gets a
    // dependents entry naming ModuleOne (asserted above). Scoping to ONLY ModuleTwo's directory must
    // make ModuleOne disappear entirely, including from ModuleTwo's dependents — a dangling "used by
    // Vendor_ModuleOne" reference would otherwise get written into ModuleTwo's generated frontmatter
    // and LLM prompt even though ModuleOne appears nowhere else in this scoped scan.
    const { modules } = await discoverProject(makeContext({ scanDir: 'app/code/Vendor/ModuleTwo' }));

    expect(modules.some((m) => m.name === 'Vendor_ModuleOne')).toBe(false);
    const moduleTwo = modules.find((m) => m.name === 'Vendor_ModuleTwo')!;
    const dependents = (moduleTwo.metadata?.dependents as Array<{ module: string; type: string }>) ?? [];
    expect(dependents.every((d) => modules.some((m) => m.id === d.module))).toBe(true);
  });
});
