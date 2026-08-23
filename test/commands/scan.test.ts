import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanCommand } from '../../src/commands/scan.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/generic-fake',
);

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-scan-json-'));
  await fs.cp(FIXTURE_ROOT, projectRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runScanJson(): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await scanCommand({ projectRoot, json: true });
  const jsonString = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  logSpy.mockRestore();
  return jsonString;
}

describe('scanCommand --json contract', () => {
  it('produces schema_version 1 output with no absPath or fixture temp-dir leakage', async () => {
    const jsonString = await runScanJson();
    const parsed = JSON.parse(jsonString);

    expect(parsed.schema_version).toBe(1);
    expect(typeof parsed.framework).toBe('string');
    expect(Array.isArray(parsed.modules)).toBe(true);
    expect(parsed.modules.length).toBeGreaterThan(0);

    // Direct proof no absolute path (which would embed the fixture's own tmpdir) leaked, and
    // that the internal absPath field name itself is gone from the output entirely.
    expect(jsonString).not.toContain(projectRoot);
    expect(jsonString).not.toContain('absPath');
  });

  it('keeps the module- and element-level key sets stable (schema tripwire)', async () => {
    const jsonString = await runScanJson();
    const parsed = JSON.parse(jsonString);

    const module = parsed.modules[0];
    expect(Object.keys(module).sort()).toEqual(
      ['elements', 'id', 'name', 'path', 'relations'].sort(),
    );

    const moduleWithElement = parsed.modules.find((m: { elements: unknown[] }) => m.elements.length > 0);
    expect(moduleWithElement).toBeDefined();
    const element = moduleWithElement.elements[0];
    expect(Object.keys(element).sort()).toEqual(['files', 'id', 'kind'].sort());

    // Top-level key set is exactly {schema_version, framework, modules} — no compat fallback of
    // the old raw {framework, modules} shape sneaking extra keys back in.
    expect(Object.keys(parsed).sort()).toEqual(['framework', 'modules', 'schema_version'].sort());
  });
});

describe('scanCommand --json contract — cross-stack relations', () => {
  const PEER_CONSUMER_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/nuxt4-peer-consumer-fake',
  );
  const PEER_BACKEND_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/magento2-peer-fake',
  );

  let peerScratchParent: string;
  let peerProjectRoot: string;

  beforeEach(async () => {
    // The consumer fixture's docmap.config.json points peers at a sibling "../magento2-peer-fake" —
    // preserve that relative layout in the scratch dir.
    peerScratchParent = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-scan-crossstack-'));
    peerProjectRoot = path.join(peerScratchParent, 'consumer');
    await fs.cp(PEER_CONSUMER_ROOT, peerProjectRoot, { recursive: true });
    await fs.cp(PEER_BACKEND_ROOT, path.join(peerScratchParent, 'magento2-peer-fake'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(peerScratchParent, { recursive: true, force: true });
  });

  it('includes structured operation/toModuleName fields on a cross-stack relation, not just detail', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await scanCommand({ projectRoot: peerProjectRoot, json: true });
    const jsonString = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();

    const parsed = JSON.parse(jsonString);
    const peerRelations = parsed.modules
      .flatMap((m: { relations: Array<{ toModule?: string }> }) => m.relations)
      .filter((r: { toModule?: string }) => r.toModule?.startsWith('peer:'));

    expect(peerRelations.length).toBeGreaterThan(0);
    for (const rel of peerRelations) {
      expect(typeof rel.operation).toBe('string');
      expect(typeof rel.toModuleName).toBe('string');
    }
  });
});
