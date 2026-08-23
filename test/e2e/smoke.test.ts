import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGenerate } from '../../src/core/orchestrator.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import { mockRunner } from '../../src/runners/mock.js';
import { ModuleFrontmatterSchema, IndexFrontmatterSchema } from '../../src/docFormat/frontmatter.js';
import { tryParseDoc } from '../../src/docFormat/parse.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/generic-fake',
);

let projectRoot: string;
const logger = createLogger();

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-e2e-'));
  await fs.cp(FIXTURE_ROOT, projectRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('e2e smoke: generate against generic-fake with mock runner', () => {
  it('writes a valid .docmap tree', async () => {
    const config = getDefaultConfig();
    const summary = await runGenerate({ projectRoot, config, logger, runnerName: 'mock' });

    expect(summary.reports.every((r) => r.outcome === 'generated')).toBe(true);

    const indexRaw = await fs.readFile(path.join(projectRoot, '.docmap', 'index.md'), 'utf8');
    const index = tryParseDoc(IndexFrontmatterSchema, indexRaw);
    expect(index).not.toBeNull();
    expect(index?.frontmatter.modules).toHaveLength(2);

    const moduleARaw = await fs.readFile(path.join(projectRoot, '.docmap', 'moduleA', 'README.md'), 'utf8');
    const moduleA = tryParseDoc(ModuleFrontmatterSchema, moduleARaw);
    expect(moduleA?.frontmatter.status).toBe('implemented');
  });

  it('makes zero runner calls on a second run with no source changes', async () => {
    const config = getDefaultConfig();
    await runGenerate({ projectRoot, config, logger, runnerName: 'mock' });

    const runSpy = vi.spyOn(mockRunner, 'run');
    await runGenerate({ projectRoot, config, logger, runnerName: 'mock' });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('regenerates only the touched module', async () => {
    const config = getDefaultConfig();
    await runGenerate({ projectRoot, config, logger, runnerName: 'mock' });

    await fs.appendFile(path.join(projectRoot, 'moduleA', 'index.ts'), '\n// touched\n');

    const runSpy = vi.spyOn(mockRunner, 'run');
    const summary = await runGenerate({ projectRoot, config, logger, runnerName: 'mock' });

    expect(runSpy).toHaveBeenCalledTimes(1);
    const outcomes = Object.fromEntries(summary.reports.map((r) => [r.moduleId, r.outcome]));
    expect(outcomes.modulea).toBe('generated');
    expect(outcomes.moduleb).toBe('skipped-up-to-date');
  });

  it('rejects an unknown --module id instead of silently generating nothing', async () => {
    const config = getDefaultConfig();

    await expect(
      runGenerate({ projectRoot, config, logger, runnerName: 'mock', moduleIds: ['not-a-real-module'] }),
    ).rejects.toThrow(/Unknown module id.*"not-a-real-module".*Available modules:.*modulea.*moduleb/s);

    // index.md must not be created/overwritten off the back of a rejected request
    await expect(fs.access(path.join(projectRoot, '.docmap', 'index.md'))).rejects.toThrow();
  });
});
