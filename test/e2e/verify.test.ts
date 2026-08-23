import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { runGenerate } from '../../src/core/orchestrator.js';
import { runVerify, VERIFY_START, VERIFY_END, type VerifyModuleReport } from '../../src/core/verify.js';
import { verifyCommand } from '../../src/commands/verify.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import { mockRunner } from '../../src/runners/mock.js';
import { readModuleDoc } from '../../src/core/docWriter.js';
import { BODY_START, BODY_END, elementStartMarker, ELEMENT_END } from '../../src/core/markers.js';
import type { RunnerInvocation, RunnerResult } from '../../src/runners/types.js';

// This suite proves the audit's exact end-to-end scenario: a module's documented business rule
// (an "Invariant") breaks in the source, and `docmap verify` must catch it — not `docmap generate`
// silently adopting the regression as the new normal — with a non-zero exit code fit for CI.
//
// runGenerate/runVerify only accept a runner NAME, looked up via src/runners/registry.ts's fixed
// RUNNERS map — there is no injected-AgentRunner option at that level (see runBatch in
// test/core/orchestratorRetry.test.ts for the lower-level pattern that sidesteps this). So instead of
// swapping the registry, this suite scripts the shared `mockRunner` singleton itself with vi.spyOn,
// exactly the "scripted runner double" idea from orchestratorRetry.test.ts, just reached through the
// registry's own object rather than a locally-built one.

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/generic-fake',
);

let projectRoot: string;
let runnerSpy: MockInstance | undefined;
const logger = createLogger();

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-verify-e2e-'));
  await fs.cp(FIXTURE_ROOT, projectRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  runnerSpy?.mockRestore();
  runnerSpy = undefined;
  vi.restoreAllMocks();
  // Some of the scenarios below deliberately set process.exitCode to prove CI behavior — never let
  // that leak out and affect the actual exit code of the test run itself.
  process.exitCode = 0;
});

function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
  return { ok: true, rawOutput: '', text: '', durationMs: 50, exitCode: 0, ...overrides };
}

/** Queues canned responses onto the shared `mockRunner` singleton's `run` method. Any previous script
 * from earlier in the same test is torn down first, so invocation counts are always scoped to just the
 * calls made while THIS script is active. */
function scriptMockRunner(results: RunnerResult[]): { invocations: RunnerInvocation[] } {
  runnerSpy?.mockRestore();
  const invocations: RunnerInvocation[] = [];
  const queue = [...results];
  runnerSpy = vi.spyOn(mockRunner, 'run').mockImplementation(async (invocation: RunnerInvocation) => {
    invocations.push(invocation);
    return queue.shift() ?? results[results.length - 1]!;
  });
  return { invocations };
}

// A generate response carrying a real "## Invariants" section, using the actual markers from
// src/core/markers.ts — same construction as orchestratorRetry.test.ts's `successText`, extended with
// the business rule from the audit's reference scenario so parseInvariantsSection (task 2.1) actually
// runs end to end and lands in the module's frontmatter.invariants array.
const generateResponseWithInvariant = [
  BODY_START,
  '## Purpose',
  'Handles order cancellation for the storefront.',
  '',
  '## Responsibilities',
  '_Cancels an order on request._',
  '',
  '## Business Logic',
  'An order may be cancelled only while it has not yet shipped.',
  '',
  '## Invariants',
  '1. An order can only be cancelled while its status is pending or on-hold.',
  '',
  '## Inputs / Outputs',
  '_None._',
  '',
  '## Relationships',
  '_None._',
  BODY_END,
  elementStartMarker('index.ts'),
  'Cancels the order after checking its status.',
  ELEMENT_END,
].join('\n');

const breakingVerifyText = [
  VERIFY_START,
  '## Summary',
  'BREAKING',
  '## Invariants',
  'I1: VIOLATED — the status guard was removed, orders can be cancelled from any status now.',
  '## Undocumented',
  '- Orders can now be cancelled after shipment, with no status check at all.',
  VERIFY_END,
].join('\n');

async function generateModuleAWithInvariant() {
  scriptMockRunner([runnerResult({ text: generateResponseWithInvariant })]);
  const config = getDefaultConfig();
  const summary = await runGenerate({
    projectRoot,
    config,
    logger,
    runnerName: 'mock',
    moduleIds: ['modulea'],
  });
  expect(summary.reports.find((r) => r.moduleId === 'modulea')?.outcome).toBe('generated');

  const moduleDoc = await readModuleDoc(projectRoot, { relRootPath: 'moduleA' });
  expect(moduleDoc?.frontmatter.invariants).toEqual([
    { id: 'I1', text: 'An order can only be cancelled while its status is pending or on-hold.' },
  ]);
  return config;
}

async function breakModuleASource() {
  await fs.appendFile(
    path.join(projectRoot, 'moduleA', 'index.ts'),
    '\nexport function cancelAnyOrder() { return true; }\n',
  );
}

describe('e2e verify: catches a violated invariant end to end', () => {
  it('reports BREAKING/VIOLATED on a real regression, writes a report, and sets a non-zero exit code', async () => {
    await generateModuleAWithInvariant();
    await breakModuleASource();

    scriptMockRunner([runnerResult({ text: breakingVerifyText })]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await verifyCommand({ projectRoot, runner: 'mock', module: ['modulea'], json: true });

    // logger.info also writes through console.log, so disambiguate the JSON.stringify(reports, ...)
    // call (a real JSON array, e.g. "[\n  {...}\n]") from plain progress lines that happen to start
    // with "[" too (e.g. "[verify] 1 modules ...").
    const jsonCall = logSpy.mock.calls.find(
      ([arg]) => typeof arg === 'string' && arg.trim().startsWith('[') && arg.trim().endsWith(']'),
    );
    expect(jsonCall).toBeDefined();
    const reports = JSON.parse(jsonCall![0] as string) as VerifyModuleReport[];
    const report = reports.find((r) => r.moduleId === 'modulea');

    expect(report?.status).toBe('verified');
    expect(report?.verdict).toBe('BREAKING');
    expect(report?.invariants).toContainEqual(
      expect.objectContaining({ id: 'I1', verdict: 'VIOLATED' }),
    );

    expect(process.exitCode).toBe(1);

    const reportsDir = path.join(projectRoot, '.docmap', '.reports');
    const reportFiles = await fs.readdir(reportsDir);
    expect(reportFiles.some((f) => f.startsWith('verify-') && f.endsWith('.md'))).toBe(true);
  });

  it('retries once on a garbled verify response and uses the final well-formed verdict', async () => {
    const config = await generateModuleAWithInvariant();
    await breakModuleASource();

    // Missing VERIFY_END and a "## Summary" value that isn't COMPATIBLE/CHANGED/BREAKING — both are
    // independently enough to make parseVerifyOutput return null and trigger a retry.
    const garbledText = [
      VERIFY_START,
      '## Summary',
      'PROBABLY_FINE',
      '## Invariants',
      'I1: VIOLATED — status guard removed.',
    ].join('\n');

    const { invocations } = scriptMockRunner([
      runnerResult({ text: garbledText }),
      runnerResult({ text: breakingVerifyText }),
    ]);

    const summary = await runVerify({
      projectRoot,
      config,
      logger,
      runnerName: 'mock',
      moduleIds: ['modulea'],
    });

    expect(invocations).toHaveLength(2);
    const report = summary.reports.find((r) => r.moduleId === 'modulea');
    expect(report?.status).toBe('verified');
    expect(report?.verdict).toBe('BREAKING');
    expect(report?.invariants).toContainEqual(
      expect.objectContaining({ id: 'I1', verdict: 'VIOLATED' }),
    );
  });

  it('reports "unchanged" and makes zero runner calls when the fingerprint still matches the doc', async () => {
    const config = await generateModuleAWithInvariant();
    // Source is left untouched — the doc's fingerprint still matches current source.

    const { invocations } = scriptMockRunner([runnerResult({ text: breakingVerifyText })]);

    const summary = await runVerify({
      projectRoot,
      config,
      logger,
      runnerName: 'mock',
      moduleIds: ['modulea'],
    });

    expect(invocations).toHaveLength(0);
    const report = summary.reports.find((r) => r.moduleId === 'modulea');
    expect(report?.status).toBe('unchanged');
    expect(report?.verdict).toBeUndefined();
  });
});
