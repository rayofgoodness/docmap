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
