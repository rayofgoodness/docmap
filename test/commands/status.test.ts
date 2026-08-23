import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusCommand } from '../../src/commands/status.js';
import { discoverProject } from '../../src/core/discovery.js';
import { computeModuleFingerprint } from '../../src/core/fingerprint.js';
import { writeBriefDoc, writeModuleDoc } from '../../src/core/docWriter.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { BriefFrontmatter, ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { DiscoveryContext, ModuleDescriptor } from '../../src/adapters/types.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/generic-fake',
);

let projectRoot: string;
const logger = createLogger();

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-status-brief-'));
  await fs.cp(FIXTURE_ROOT, projectRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeTechFrontmatter(module: ModuleDescriptor, fingerprint: string): ModuleFrontmatter {
  return {
    docmap_version: 1,
    kind: 'module',
    id: module.id,
    name: module.name,
    framework: module.framework,
    path: module.relRootPath,
    status: 'implemented',
    language: 'en',
    fingerprint,
    generated_at: '2026-01-01T00:00:00.000Z',
    generated_by: { runner: 'mock' },
    elements: [],
    invariants: [],
    dependencies: [],
    dependents: [],
    tags: [],
  };
}

function makeBriefFrontmatter(module: ModuleDescriptor, sourceFingerprint: string | null): BriefFrontmatter {
  return {
    docmap_version: 1,
    kind: 'brief',
    module: module.id,
    language: 'en',
    source_fingerprint: sourceFingerprint,
    generated_at: '2026-01-01T00:00:00.000Z',
    generated_by: { runner: 'mock' },
  };
}

async function runStatusJson(): Promise<Array<{ moduleId: string; name: string; status: string; briefStatus: string }>> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await statusCommand({ projectRoot, json: true });
  const jsonString = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  logSpy.mockRestore();
  return JSON.parse(jsonString);
}

describe('statusCommand briefStatus', () => {
  it('reports missing/up-to-date/stale for the brief independently of (but combined with) the tech doc status', async () => {
    const config = getDefaultConfig();
    const ctx: DiscoveryContext = { projectRoot, config, logger };
    const { modules } = await discoverProject(ctx);

    const moduleA = modules.find((m) => m.name === 'moduleA')!;
    const moduleB = modules.find((m) => m.name === 'moduleB')!;
    expect(moduleA && moduleB).toBeTruthy();

    // moduleA: no tech doc at all -> both missing.

    // moduleB: up-to-date tech doc, brief matches it -> both up-to-date.
    const fpB = await computeModuleFingerprint(moduleB);
    await writeModuleDoc(projectRoot, moduleB, makeTechFrontmatter(moduleB, fpB), '## Business Logic\nB.');
    await writeBriefDoc(projectRoot, moduleB, makeBriefFrontmatter(moduleB, fpB), '## What this module does\nB.');

    const reports = await runStatusJson();

    const byName = new Map(reports.map((r) => [r.name, r]));
    const reportA = byName.get('moduleA')!;
    const reportB = byName.get('moduleB')!;

    expect(reportA.status).toBe('missing');
    expect(reportA.briefStatus).toBe('missing');

    expect(reportB.status).toBe('up-to-date');
    expect(reportB.briefStatus).toBe('up-to-date');
  });

  it('marks the brief stale when the tech doc itself is stale, even though the brief matches that stale fingerprint', async () => {
    const config = getDefaultConfig();
    const ctx: DiscoveryContext = { projectRoot, config, logger };
    const { modules } = await discoverProject(ctx);
    const moduleB = modules.find((m) => m.name === 'moduleB')!;

    // Tech doc fingerprint deliberately does NOT match current source -> tech doc itself is stale.
    await writeModuleDoc(projectRoot, moduleB, makeTechFrontmatter(moduleB, 'sha256:stale-marker'), '## Business Logic\nB.');
    // Brief matches the (stale) tech doc fingerprint exactly, but must still read as stale overall.
    await writeBriefDoc(projectRoot, moduleB, makeBriefFrontmatter(moduleB, 'sha256:stale-marker'), '## What this module does\nB.');

    const reports = await runStatusJson();
    const report = reports.find((r) => r.name === 'moduleB')!;

    expect(report.status).toBe('stale');
    expect(report.briefStatus).toBe('stale');
  });

  it('marks the brief stale when it exists but its source_fingerprint no longer matches the (up-to-date) tech doc', async () => {
    const config = getDefaultConfig();
    const ctx: DiscoveryContext = { projectRoot, config, logger };
    const { modules } = await discoverProject(ctx);
    const moduleB = modules.find((m) => m.name === 'moduleB')!;

    const fpB = await computeModuleFingerprint(moduleB);
    await writeModuleDoc(projectRoot, moduleB, makeTechFrontmatter(moduleB, fpB), '## Business Logic\nB.');
    await writeBriefDoc(projectRoot, moduleB, makeBriefFrontmatter(moduleB, 'sha256:old-tech-fp'), '## What this module does\nB.');

    const reports = await runStatusJson();
    const report = reports.find((r) => r.name === 'moduleB')!;

    expect(report.status).toBe('up-to-date');
    expect(report.briefStatus).toBe('stale');
  });

  it('prints a two-status human-readable line per module', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await statusCommand({ projectRoot });
    const lines = logSpy.mock.calls.map((call) => call.join(' '));
    logSpy.mockRestore();

    expect(lines.some((l) => l.includes('missing') && l.includes('moduleA'))).toBe(true);
  });
});
