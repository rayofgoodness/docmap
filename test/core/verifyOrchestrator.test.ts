import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyModule, writeVerifyReport, VERIFY_END, VERIFY_START, type VerifyModuleReport } from '../../src/core/verify.js';
import { genericAdapter } from '../../src/adapters/generic/index.js';
import { writeBriefDoc, writeModuleDoc } from '../../src/core/docWriter.js';
import { computeModuleFingerprint } from '../../src/core/fingerprint.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { BriefFrontmatter, ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { AgentRunner, RunnerInvocation, RunnerResult } from '../../src/runners/types.js';
import type { DiscoveryContext, ModuleDescriptor } from '../../src/adapters/types.js';

let tmpDir: string;
const logger = createLogger();

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-verify-orch-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeModule(): Promise<ModuleDescriptor> {
  await fs.mkdir(path.join(tmpDir, 'orders'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'orders', 'index.ts'),
    'export function cancelOrder(order) { return order.status === "pending"; }',
  );
  const ctx: DiscoveryContext = { projectRoot: tmpDir, config: getDefaultConfig(), logger };
  const modules = await genericAdapter.discoverModules(ctx);
  const module = modules.find((m) => m.name === 'orders');
  if (!module) throw new Error('fixture module not discovered');
  return module;
}

function makeFrontmatter(overrides: Partial<ModuleFrontmatter>): ModuleFrontmatter {
  return {
    docmap_version: 1,
    kind: 'module',
    id: 'orders',
    name: 'orders',
    framework: 'generic',
    path: 'orders',
    status: 'implemented',
    language: 'en',
    fingerprint: 'sha256:stale-marker',
    generated_at: '2026-01-01T00:00:00.000Z',
    generated_by: { runner: 'mock' },
    elements: [],
    invariants: [{ id: 'I1', text: 'An order can only be cancelled while pending or on-hold.' }],
    dependencies: [],
    dependents: [],
    tags: [],
    ...overrides,
  };
}

function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
  return { ok: true, rawOutput: '', text: '', durationMs: 50, exitCode: 0, ...overrides };
}

function fakeRunner(results: RunnerResult[]): { runner: AgentRunner; invocations: RunnerInvocation[] } {
  const invocations: RunnerInvocation[] = [];
  const queue = [...results];
  return {
    invocations,
    runner: {
      name: 'mock',
      async checkAvailable() {
        return { available: true };
      },
      async run(invocation) {
        invocations.push(invocation);
        return queue.shift() ?? results[results.length - 1]!;
      },
    },
  };
}

const compatibleVerifyText = [
  VERIFY_START,
  '## Summary',
  'COMPATIBLE',
  '## Invariants',
  'I1: KEPT — cancellation is still gated on status === "pending".',
  '## Undocumented',
  '(none)',
  VERIFY_END,
].join('\n');

const breakingVerifyText = [
  VERIFY_START,
  '## Summary',
  'BREAKING',
  '## Invariants',
  'I1: VIOLATED — cancellation now happens regardless of status.',
  '## Undocumented',
  '- Orders can now be cancelled from any status, not just pending/on-hold.',
  VERIFY_END,
].join('\n');

async function callVerifyModule(module: ModuleDescriptor, runner: AgentRunner, configOverrides = {}): Promise<VerifyModuleReport> {
  const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000, ...configOverrides };
  return verifyModule({ module, projectRoot: tmpDir, config, logger, runner });
}

describe('verifyModule', () => {
  it('reports "missing" and makes no runner call when there is no existing doc', async () => {
    const module = await makeModule();
    const { runner, invocations } = fakeRunner([runnerResult({ text: compatibleVerifyText })]);

    const report = await callVerifyModule(module, runner);

    expect(report.status).toBe('missing');
    expect(invocations).toHaveLength(0);
  });

  it('reports "unchanged" and makes no runner call when the fingerprint matches the doc', async () => {
    const module = await makeModule();
    const fingerprint = await computeModuleFingerprint(module);
    await writeModuleDoc(tmpDir, module, makeFrontmatter({ fingerprint }), '## Business Logic\nOrders.');

    const { runner, invocations } = fakeRunner([runnerResult({ text: compatibleVerifyText })]);
    const report = await callVerifyModule(module, runner);

    expect(report.status).toBe('unchanged');
    expect(invocations).toHaveLength(0);
  });

  it('calls the runner once for a stale doc and parses the returned verdict', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');

    const { runner, invocations } = fakeRunner([runnerResult({ text: breakingVerifyText })]);
    const report = await callVerifyModule(module, runner);

    expect(invocations).toHaveLength(1);
    expect(report.status).toBe('verified');
    expect(report.verdict).toBe('BREAKING');
    expect(report.invariants).toEqual([
      { id: 'I1', verdict: 'VIOLATED', note: 'cancellation now happens regardless of status.' },
    ]);
    expect(report.undocumented).toEqual(['Orders can now be cancelled from any status, not just pending/on-hold.']);
    expect(report.error).toBeUndefined();
  });

  it('retries once after a malformed response and uses the well-formed retry result', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');

    const { runner, invocations } = fakeRunner([
      runnerResult({ text: 'chatty response without any verify markers' }),
      runnerResult({ text: compatibleVerifyText }),
    ]);
    const report = await callVerifyModule(module, runner);

    expect(invocations).toHaveLength(2);
    expect(invocations[1]!.prompt).toContain('did not follow the required output contract');
    expect(report.status).toBe('verified');
    expect(report.verdict).toBe('COMPATIBLE');
    expect(report.error).toBeUndefined();
  });

  it('surfaces a parse failure as report.error rather than defaulting to COMPATIBLE', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');

    const { runner } = fakeRunner([
      runnerResult({ text: 'still no markers' }),
      runnerResult({ text: 'still no markers on retry either' }),
    ]);
    const report = await callVerifyModule(module, runner);

    expect(report.status).toBe('verified');
    expect(report.verdict).toBeUndefined();
    expect(report.error).toBeTruthy();
  });

  it('reports the DOUBLED (escalated) timeout in the failure reason, not the original config timeout', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');

    // First attempt looks like a timeout at the original 1000ms budget (ok:false, durationMs close to
    // timeoutMs) — that escalates the retry's timeout to 2000ms. The second attempt then fails again
    // (still not a valid parse), exhausting maxRetries:1, so runVerifyCall/verifyModule must describe
    // the failure using the LAST attempt's actual (doubled) budget, not the original 1000ms.
    const { runner } = fakeRunner([
      runnerResult({ ok: false, durationMs: 980, exitCode: null }),
      runnerResult({ ok: false, durationMs: 1900, exitCode: null }),
    ]);
    const report = await callVerifyModule(module, runner, { timeoutMs: 1000, maxRetries: 1 });

    expect(report.status).toBe('verified');
    expect(report.error).toBeTruthy();
    expect(report.error).toContain('2s limit');
    expect(report.error).not.toContain('1s limit');
  });
});

function fakeModule(id: string, relRootPath: string): ModuleDescriptor {
  return {
    id,
    name: id,
    rootPath: path.join(tmpDir, relRootPath),
    relRootPath,
    framework: 'generic',
    elements: [],
    relations: [],
    files: [],
  };
}

function briefFrontmatter(moduleId: string, sourceFingerprint = 'sha256:whatever'): BriefFrontmatter {
  return {
    docmap_version: 1,
    kind: 'brief',
    module: moduleId,
    language: 'en',
    source_fingerprint: sourceFingerprint,
    generated_at: '2026-01-01T00:00:00.000Z',
    generated_by: { runner: 'mock' },
  };
}

const checkoutBriefBody = [
  '## What this module does',
  'Checkout finalizes a customer order once payment succeeds.',
  '',
  '## Key scenarios',
  '- A customer pays for their cart and the order is finalized.',
  '',
  '## Business rules',
  'I1: An order can only be marked paid once the payment processor confirms the charge.',
  '',
  '## What to check after changes',
  'I1: Pay for an order and confirm it only moves to paid after the payment processor confirms success.',
  '',
  '## Dependency risks',
  '- (no other modules currently depend on this one)',
].join('\n');

const breakingCheckoutReport: VerifyModuleReport = {
  moduleId: 'checkout',
  name: 'checkout',
  status: 'verified',
  verdict: 'BREAKING',
  invariants: [{ id: 'I1', verdict: 'VIOLATED', note: 'no longer enforced.' }],
  undocumented: ['New auto-refund path.'],
  sourceFingerprint: 'sha256:whatever',
};

describe('writeVerifyReport', () => {
  it('writes a timestamped markdown report with a summary table and CHANGED/BREAKING details', async () => {
    const reports: VerifyModuleReport[] = [
      { moduleId: 'orders', name: 'orders', status: 'unchanged' },
      { moduleId: 'cart', name: 'cart', status: 'missing' },
      breakingCheckoutReport,
    ];

    const filePath = await writeVerifyReport(tmpDir, reports, new Date(2026, 0, 15, 9, 5, 42));

    expect(filePath).toBe(path.join(tmpDir, '.docmap', '.reports', 'verify-2026-01-15-090542.md'));
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('| orders (orders) | unchanged | - |');
    expect(content).toContain('| checkout (checkout) | verified | BREAKING |');
    expect(content).toContain('### checkout (checkout) — BREAKING');
    expect(content).toContain('I1: VIOLATED — no longer enforced.');
    expect(content).toContain('New auto-refund path.');
  });

  it('adds a "### For managers" subsection, reusing the brief\'s plain-language text, when a matching brief exists on disk', async () => {
    const module = fakeModule('checkout', 'checkout');
    await writeBriefDoc(tmpDir, module, briefFrontmatter('checkout'), checkoutBriefBody);

    const reports: VerifyModuleReport[] = [breakingCheckoutReport];
    const filePath = await writeVerifyReport(tmpDir, reports, new Date(2026, 0, 15, 9, 6), [module]);
    const content = await fs.readFile(filePath, 'utf8');

    // Existing iteration-2 technical content is completely unaffected.
    expect(content).toContain('| checkout (checkout) | verified | BREAKING |');
    expect(content).toContain('### checkout (checkout) — BREAKING');
    expect(content).toContain('I1: VIOLATED — no longer enforced.');
    expect(content).toContain('New auto-refund path.');

    // New plain-language enrichment, reusing the brief's own wording rather than a fresh LLM call.
    expect(content).toContain('### For managers');
    expect(content).toContain(
      'I1: An order can only be marked paid once the payment processor confirms the charge.',
    );
    expect(content).toContain(
      'what this means: this behavior may no longer work as expected — verify by: Pay for an order and confirm it only moves to paid after the payment processor confirms success.',
    );
  });

  it('omits the "### For managers" subsection when the on-disk brief\'s source_fingerprint no longer matches this verdict\'s baseline (stale brief, ids may not correspond)', async () => {
    const module = fakeModule('checkout', 'checkout');
    // Brief was generated from an OLDER tech-doc revision than the one this verdict was checked against —
    // I1 in the stale brief may name a completely different rule than I1 in breakingCheckoutReport.
    await writeBriefDoc(tmpDir, module, briefFrontmatter('checkout', 'sha256:an-older-revision'), checkoutBriefBody);

    const reports: VerifyModuleReport[] = [breakingCheckoutReport];
    const filePath = await writeVerifyReport(tmpDir, reports, new Date(2026, 0, 15, 9, 8), [module]);
    const content = await fs.readFile(filePath, 'utf8');

    expect(content).not.toContain('For managers');
    // Technical content is still rendered normally.
    expect(content).toContain('### checkout (checkout) — BREAKING');
    expect(content).toContain('I1: VIOLATED — no longer enforced.');
  });

  it('omits the "### For managers" subsection (without erroring) when no brief exists on disk for the module', async () => {
    const module = fakeModule('checkout', 'checkout');
    // Deliberately no writeBriefDoc call — no brief on disk for this module.

    const reports: VerifyModuleReport[] = [breakingCheckoutReport];
    const filePath = await writeVerifyReport(tmpDir, reports, new Date(2026, 0, 15, 9, 7), [module]);
    const content = await fs.readFile(filePath, 'utf8');

    expect(content).not.toContain('For managers');

    // Existing iteration-2 technical content is still completely unaffected.
    expect(content).toContain('| checkout (checkout) | verified | BREAKING |');
    expect(content).toContain('### checkout (checkout) — BREAKING');
    expect(content).toContain('I1: VIOLATED — no longer enforced.');
    expect(content).toContain('New auto-refund path.');
  });

  it('sanitizes a report.error containing a newline and a pipe so the summary table row stays well-formed', async () => {
    const reports: VerifyModuleReport[] = [
      {
        moduleId: 'orders',
        name: 'orders',
        status: 'verified',
        error: 'runner failed: stderr line one\nstderr line two | with a pipe',
      },
    ];

    const filePath = await writeVerifyReport(tmpDir, reports, new Date(2026, 0, 15, 9, 8, 0));
    const content = await fs.readFile(filePath, 'utf8');

    // The report has exactly one summary row per input report — a raw newline in r.error would have
    // split it across multiple physical lines, so this lookup alone proves the row stayed intact.
    const rows = content.split('\n').filter((l) => l.startsWith('| orders (orders)'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The literal "|" from the error text must have been escaped (backslash-pipe), not left bare —
    // a bare pipe would open an unintended 4th table column.
    expect(row).toContain('stderr line one stderr line two \\| with a pipe');
    expect(row).not.toContain('\n');
  });
});
