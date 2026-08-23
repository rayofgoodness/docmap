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
