import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, formatUpdateNotice, isNewerVersion } from '../../src/utils/updateCheck.js';

describe('isNewerVersion', () => {
  it('compares major, minor, and patch numerically', () => {
    expect(isNewerVersion('0.8.0', '0.7.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.7.2', '0.7.1')).toBe(true);
    expect(isNewerVersion('0.7.10', '0.7.9')).toBe(true);
    expect(isNewerVersion('0.7.1', '0.7.1')).toBe(false);
    expect(isNewerVersion('0.7.0', '0.7.1')).toBe(false);
  });

  it('tolerates a leading v and never reports malformed versions as newer', () => {
    expect(isNewerVersion('v0.8.0', '0.7.1')).toBe(true);
    expect(isNewerVersion('not-a-version', '0.7.1')).toBe(false);
    expect(isNewerVersion('0.8.0', 'garbage')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'docmap-update-'));
    cachePath = path.join(dir, 'update-check.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const registryFetch = (version: string) =>
    vi.fn(async () => ({ ok: true, json: async () => ({ version }) })) as unknown as typeof fetch;

  const base = { packageName: '@scope/pkg', currentVersion: '0.7.1', env: {} as NodeJS.ProcessEnv };

  it('fetches the registry, caches the result, and reports a newer version', async () => {
    const fetchImpl = registryFetch('0.8.0');
    const latest = await checkForUpdate({ ...base, cachePath, fetchImpl, now: () => 1000 });
    expect(latest).toBe('0.8.0');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual({ lastCheckMs: 1000, latest: '0.8.0' });
  });

  it('returns null when the published version is not newer', async () => {
    const latest = await checkForUpdate({ ...base, cachePath, fetchImpl: registryFetch('0.7.1') });
    expect(latest).toBeNull();
  });

  it('uses a fresh cache without hitting the registry', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckMs: 1000, latest: '0.9.0' }));
    const fetchImpl = registryFetch('0.8.0');
    const latest = await checkForUpdate({ ...base, cachePath, fetchImpl, now: () => 1000 + 60 * 60 * 1000 });
    expect(latest).toBe('0.9.0');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refetches once the cache is older than the check interval', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckMs: 0, latest: '0.9.0' }));
    const fetchImpl = registryFetch('0.8.0');
    const latest = await checkForUpdate({ ...base, cachePath, fetchImpl, now: () => 25 * 60 * 60 * 1000 });
    expect(latest).toBe('0.8.0');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('is silent on network failure and on a non-ok registry response', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ ...base, cachePath, fetchImpl: failing })).toBeNull();

    const notOk = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await checkForUpdate({ ...base, cachePath, fetchImpl: notOk })).toBeNull();
  });

  it('survives a corrupt cache file', async () => {
    writeFileSync(cachePath, 'not json');
    const latest = await checkForUpdate({ ...base, cachePath, fetchImpl: registryFetch('0.8.0') });
    expect(latest).toBe('0.8.0');
  });

  it.each([{ DOCMAP_NO_UPDATE_CHECK: '1' }, { CI: 'true' }])('skips entirely when %o is set', async (env) => {
    const fetchImpl = registryFetch('0.8.0');
    const latest = await checkForUpdate({ ...base, cachePath, fetchImpl, env: env as NodeJS.ProcessEnv });
    expect(latest).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('formatUpdateNotice', () => {
  it('names both versions and the install command', () => {
    const notice = formatUpdateNotice('@scope/pkg', '0.7.1', '0.8.0', false);
    expect(notice).toBe('[docmap] update available 0.7.1 → 0.8.0 · npm i -g @scope/pkg');
  });

  it('wraps in yellow ANSI only when color is requested', () => {
    expect(formatUpdateNotice('@scope/pkg', '0.7.1', '0.8.0', true)).toMatch(/^\x1b\[33m.*\x1b\[0m$/);
    expect(formatUpdateNotice('@scope/pkg', '0.7.1', '0.8.0', false)).not.toContain('\x1b');
  });
});
