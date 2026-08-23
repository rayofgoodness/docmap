import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  BRIEF_END,
  BRIEF_START,
  briefModule,
  buildBriefPrompt,
  parseBriefOutput,
  runBrief,
  type BriefModuleReport,
} from '../../src/core/brief.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { getSectionLabels } from '../../src/utils/lang.js';
import { readBriefDoc, readGlossaryDoc, writeModuleDoc } from '../../src/core/docWriter.js';
import { genericAdapter } from '../../src/adapters/generic/index.js';
import { mockRunner } from '../../src/runners/mock.js';
import { BODY_END, BODY_START } from '../../src/core/markers.js';
import { createLogger } from '../../src/utils/logger.js';
import type { ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { AgentRunner, RunnerInvocation, RunnerResult } from '../../src/runners/types.js';
import type { DiscoveryContext, ModuleDescriptor } from '../../src/adapters/types.js';

describe('parseBriefOutput', () => {
  const labels = getSectionLabels('en');
  const allHeadings = [
    `## ${labels.briefWhatItDoes}`,
    `## ${labels.briefKeyScenarios}`,
    `## ${labels.briefBusinessRules}`,
    `## ${labels.briefWhatToCheck}`,
    `## ${labels.briefDependencyRisks}`,
  ];

  function completeBody(): string {
    return [
      `${labels.briefWhatItDoes}\nOrders lets shoppers buy things.`,
      `${labels.briefKeyScenarios}\n- A shopper places an order.`,
      `${labels.briefBusinessRules}\nI1: An order can only be cancelled while pending.`,
      `${labels.briefWhatToCheck}\nI1: Cancel a pending order and confirm it moves to cancelled.`,
      `${labels.briefDependencyRisks}\n- (no other modules currently depend on this one)`,
    ]
      .map((s) => `## ${s}`)
      .join('\n\n');
  }

  it('extracts and trims the content of a valid, structurally-complete block', () => {
    const text = `chatter before\n${BRIEF_START}\n${completeBody()}\n${BRIEF_END}\nchatter after`;
    const result = parseBriefOutput(text, labels, ['I1']);
    expect(result).not.toBeNull();
    for (const heading of allHeadings) expect(result).toContain(heading);
  });

  it('returns null when the markers are missing entirely', () => {
    expect(parseBriefOutput('## What this module does\nsome prose', labels, [])).toBeNull();
  });

  it('returns null when only BRIEF_START is present (no closing marker)', () => {
    expect(parseBriefOutput(`${BRIEF_START}\n## What this module does\n...`, labels, [])).toBeNull();
  });

  it('returns null when a required heading is missing (e.g. Dependency risks dropped)', () => {
    const incomplete = [
      `## ${labels.briefWhatItDoes}\nOrders lets shoppers buy things.`,
      `## ${labels.briefKeyScenarios}\n- A shopper places an order.`,
      `## ${labels.briefBusinessRules}\nI1: An order can only be cancelled while pending.`,
      `## ${labels.briefWhatToCheck}\nI1: Cancel a pending order and confirm it moves to cancelled.`,
    ].join('\n\n');
    const text = `${BRIEF_START}\n${incomplete}\n${BRIEF_END}`;
    expect(parseBriefOutput(text, labels, ['I1'])).toBeNull();
  });

  it('returns null when a promised invariant id never appears in the body', () => {
    const text = `${BRIEF_START}\n${completeBody()}\n${BRIEF_END}`;
    // completeBody() only covers I1 — asking for I2 too must fail the contract check.
    expect(parseBriefOutput(text, labels, ['I1', 'I2'])).toBeNull();
  });

  it('accepts a body with zero invariants when none were required', () => {
    const text = `${BRIEF_START}\n${completeBody()}\n${BRIEF_END}`;
    expect(parseBriefOutput(text, labels, [])).not.toBeNull();
  });
});

describe('buildBriefPrompt', () => {
  const module: ModuleDescriptor = {
    id: 'orders',
    name: 'Orders',
    rootPath: '/tmp/orders',
    relRootPath: 'orders',
    framework: 'generic',
    elements: [],
    relations: [],
    files: [],
  };

  function makeFrontmatter(invariants: ModuleFrontmatter['invariants']): ModuleFrontmatter {
    return {
      docmap_version: 1,
      kind: 'module',
      id: 'orders',
      name: 'Orders',
      framework: 'generic',
      path: 'orders',
      status: 'implemented',
      language: 'en',
      fingerprint: 'sha256:tech-doc-fp',
      generated_at: '2026-01-01T00:00:00.000Z',
      generated_by: { runner: 'mock' },
      elements: [],
      invariants,
      dependencies: [],
      dependents: [],
      tags: [],
    };
  }

  it('lists every invariant id explicitly and requires it in both business rules and what-to-check', () => {
    const techDoc = {
      frontmatter: makeFrontmatter([
        { id: 'I1', text: 'An order can only be cancelled while pending or on-hold.' },
        { id: 'I2', text: 'A discount never exceeds 50% of the item price.' },
      ]),
      body: '## Business Logic\nOrders can be placed and cancelled.\n\n## Invariants\n1. An order can only be cancelled while pending or on-hold.\n2. A discount never exceeds 50% of the item price.',
    };

    const prompt = buildBriefPrompt(module, techDoc, getSectionLabels('en'), 'en');

    expect(prompt).toContain('=== TECH DOC (source of truth) ===');
    expect(prompt).toContain(techDoc.body);
    expect(prompt).toContain('I1: An order can only be cancelled while pending or on-hold.');
    expect(prompt).toContain('I2: A discount never exceeds 50% of the item price.');
    expect(prompt).toContain(BRIEF_START);
    expect(prompt).toContain(BRIEF_END);
    expect(prompt).toContain('## Business rules');
    expect(prompt).toContain('## What to check after changes');
    expect(prompt).toContain('I1: <the invariant retold in plain, non-technical language>');
    expect(prompt).toContain('I2: <the invariant retold in plain, non-technical language>');
    expect(prompt).toContain('I1: <a concrete, imperative QA step testing exactly that rule>');
    expect(prompt).toContain('I2: <a concrete, imperative QA step testing exactly that rule>');
    expect(prompt).toContain('no other modules currently depend on this one');
  });

  it('handles the zero-invariants case by instructing "(none documented)" instead of per-id lines', () => {
    const techDoc = {
      frontmatter: makeFrontmatter([]),
      body: '## Business Logic\nOrders can be placed.',
    };

    const prompt = buildBriefPrompt(module, techDoc, getSectionLabels('en'), 'en');

    expect(prompt).toContain('declares no invariants');
    expect(prompt).toContain('(none documented)');
  });

  it('notes dependents from module.metadata when present', () => {
    const moduleWithDependents: ModuleDescriptor = {
      ...module,
      metadata: { dependents: [{ module: 'cart', type: 'store' }] },
    };
    const techDoc = { frontmatter: makeFrontmatter([]), body: '## Business Logic\nOrders.' };

    const prompt = buildBriefPrompt(moduleWithDependents, techDoc, getSectionLabels('en'), 'en');

    expect(prompt).toContain('cart (store)');
  });
});

describe('briefModule', () => {
  let tmpDir: string;
  const logger = createLogger();

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-brief-'));
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

  function makeTechFrontmatter(overrides: Partial<ModuleFrontmatter>): ModuleFrontmatter {
    return {
      docmap_version: 1,
      kind: 'module',
      id: 'orders',
      name: 'orders',
      framework: 'generic',
      path: 'orders',
      status: 'implemented',
      language: 'en',
      fingerprint: 'sha256:tech-fp',
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

  const goodBriefText = [
    BRIEF_START,
    '## What this module does',
    'Orders lets shoppers place and cancel orders.',
    '',
    '## Key scenarios',
    '- A shopper cancels an order before it ships.',
    '',
    '## Business rules',
    'I1: An order can only be cancelled while it is pending or on-hold.',
    '',
    '## What to check after changes',
    'I1: Create an order, set it to pending, cancel it, confirm it moves to cancelled.',
    '',
    '## Dependency risks',
    '- (no other modules currently depend on this one)',
    BRIEF_END,
  ].join('\n');

  async function callBriefModule(
    module: ModuleDescriptor,
    runner: AgentRunner,
    configOverrides = {},
  ): Promise<BriefModuleReport> {
    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000, ...configOverrides };
    return briefModule({ module, projectRoot: tmpDir, config, logger, runner });
  }

  it('reports "missing" and makes no runner call when there is no tech doc', async () => {
    const module = await makeModule();
    const { runner, invocations } = fakeRunner([runnerResult({ text: goodBriefText })]);

    const report = await callBriefModule(module, runner);

    expect(report.status).toBe('missing');
    expect(invocations).toHaveLength(0);
  });

  it('reports "unchanged" and makes no runner call when the existing brief fingerprint matches the tech doc', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeTechFrontmatter({ fingerprint: 'sha256:tech-fp' }), '## Business Logic\nOrders.');

    const { runner, invocations } = fakeRunner([runnerResult({ text: goodBriefText })]);
    // Prime an up-to-date brief by running once, then run again to confirm the second call is a no-op.
    const first = await callBriefModule(module, runner);
    expect(first.status).toBe('generated');
    expect(invocations).toHaveLength(1);

    const second = await callBriefModule(module, runner);
    expect(second.status).toBe('unchanged');
    expect(invocations).toHaveLength(1);
  });

  it('calls the runner for a stale/missing brief and writes it with the tech doc fingerprint and all invariant ids traced through', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeTechFrontmatter({ fingerprint: 'sha256:tech-fp' }), '## Business Logic\nOrders.');

    const { runner, invocations } = fakeRunner([runnerResult({ text: goodBriefText })]);
    const report = await callBriefModule(module, runner);

    expect(invocations).toHaveLength(1);
    expect(report.status).toBe('generated');
    expect(report.error).toBeUndefined();

    const written = await readBriefDoc(tmpDir, module);
    expect(written).not.toBeNull();
    expect(written!.frontmatter.source_fingerprint).toBe('sha256:tech-fp');
    expect(written!.frontmatter.kind).toBe('brief');
    expect(written!.body).toContain('I1: An order can only be cancelled while it is pending or on-hold.');
    expect(written!.body).toContain('I1: Create an order, set it to pending, cancel it, confirm it moves to cancelled.');
  });

  it('surfaces a parse failure as report.error and does not write a brief', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeTechFrontmatter({ fingerprint: 'sha256:tech-fp' }), '## Business Logic\nOrders.');

    const { runner } = fakeRunner([
      runnerResult({ text: 'chatty response without any brief markers' }),
      runnerResult({ text: 'still no markers on retry either' }),
    ]);
    const report = await callBriefModule(module, runner);

    expect(report.status).toBe('error');
    expect(report.error).toBeTruthy();
    expect(await readBriefDoc(tmpDir, module)).toBeNull();
  });

  it('regenerates instead of skipping when the tech doc fingerprint matches but the requested language changed', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeTechFrontmatter({ fingerprint: 'sha256:tech-fp' }), '## Business Logic\nOrders.');

    const ukLabels = getSectionLabels('uk');
    const ukGoodBriefText = [
      BRIEF_START,
      `## ${ukLabels.briefWhatItDoes}`,
      'Модуль замовлень дозволяє покупцям розміщувати та скасовувати замовлення.',
      '',
      `## ${ukLabels.briefKeyScenarios}`,
      '- Покупець скасовує замовлення до відправлення.',
      '',
      `## ${ukLabels.briefBusinessRules}`,
      'I1: Замовлення можна скасувати лише в статусі pending або on-hold.',
      '',
      `## ${ukLabels.briefWhatToCheck}`,
      'I1: Створити замовлення, перевести в pending, скасувати, підтвердити статус cancelled.',
      '',
      `## ${ukLabels.briefDependencyRisks}`,
      '- (жоден інший модуль наразі не залежить від цього)',
      BRIEF_END,
    ].join('\n');

    const { runner, invocations } = fakeRunner([
      runnerResult({ text: goodBriefText }),
      runnerResult({ text: ukGoodBriefText }),
    ]);
    const first = await callBriefModule(module, runner);
    expect(first.status).toBe('generated');
    expect((await readBriefDoc(tmpDir, module))!.frontmatter.language).toBe('en');

    // Same tech doc, same fingerprint — but this run asks for a different language.
    const second = await callBriefModule(module, runner, { language: 'uk' });
    expect(second.status).toBe('generated');
    expect(invocations).toHaveLength(2);
    expect((await readBriefDoc(tmpDir, module))!.frontmatter.language).toBe('uk');
  });

  it('effectiveTimeoutMs in the error message reflects a doubled retry timeout, not the original config value', async () => {
    const module = await makeModule();
    await writeModuleDoc(tmpDir, module, makeTechFrontmatter({ fingerprint: 'sha256:tech-fp' }), '## Business Logic\nOrders.');

    // First attempt looks like a timeout (not ok, duration close to timeoutMs) -> escalates to 2000ms;
    // second attempt fails outright, exhausting maxRetries: 1.
    const { runner } = fakeRunner([
      runnerResult({ ok: false, durationMs: 980, exitCode: null }),
      runnerResult({ ok: false, durationMs: 1900, exitCode: 1, error: 'boom' }),
    ]);
    const report = await callBriefModule(module, runner, { maxRetries: 1, timeoutMs: 1000 });

    expect(report.status).toBe('error');
    expect(report.error).toContain('2s limit');
    expect(report.error).not.toContain('1s limit');
  });
});

// runBrief only accepts a runner NAME (looked up via src/runners/registry.ts), not an injected
// AgentRunner — so, same as test/e2e/verify.test.ts, this scripts the shared `mockRunner` singleton
// itself with vi.spyOn rather than swapping the registry.
describe('runBrief — glossary wiring (task 3.2)', () => {
  let tmpDir: string;
  const logger = createLogger();
  let runnerSpy: MockInstance | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-brief-glossary-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    runnerSpy?.mockRestore();
    runnerSpy = undefined;
    vi.restoreAllMocks();
  });

  async function makeTwoModules(): Promise<ModuleDescriptor[]> {
    await fs.mkdir(path.join(tmpDir, 'orders'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'orders', 'index.ts'),
      'export function cancelOrder(order) { return order.status === "pending"; }',
    );
    await fs.mkdir(path.join(tmpDir, 'cart'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'cart', 'index.ts'), 'export function addToCart(item) { return item; }');

    const ctx: DiscoveryContext = { projectRoot: tmpDir, config: getDefaultConfig(), logger };
    return genericAdapter.discoverModules(ctx);
  }

  function makeTechFrontmatter(module: ModuleDescriptor): ModuleFrontmatter {
    return {
      docmap_version: 1,
      kind: 'module',
      id: module.id,
      name: module.name,
      framework: 'generic',
      path: module.relRootPath,
      status: 'implemented',
      language: 'en',
      fingerprint: `sha256:${module.id}-fp`,
      generated_at: '2026-01-01T00:00:00.000Z',
      generated_by: { runner: 'mock' },
      elements: [],
      invariants: [],
      dependencies: [],
      dependents: [],
      tags: [],
    };
  }

  async function seedTechDocs(modules: ModuleDescriptor[]): Promise<void> {
    for (const module of modules) {
      await writeModuleDoc(tmpDir, module, makeTechFrontmatter(module), '## Business Logic\nStub tech doc.');
    }
  }

  function briefTextFor(moduleId: string): string {
    return [
      BRIEF_START,
      '## What this module does',
      `The ${moduleId} module handles ${moduleId}-related shopper actions.`,
      '',
      '## Key scenarios',
      `- A shopper interacts with ${moduleId}.`,
      '',
      '## Business rules',
      '(none documented)',
      '',
      '## What to check after changes',
      '(none documented)',
      '',
      '## Dependency risks',
      '- (no other modules currently depend on this one)',
      BRIEF_END,
    ].join('\n');
  }

  const glossaryText = [
    BODY_START,
    '- **order** — A purchase a shopper makes. — lives in: `orders`',
    '- **cart** — Items a shopper intends to buy. — lives in: `cart`',
    BODY_END,
  ].join('\n');

  /** Every module-id call gets a valid brief response; the aggregation call (moduleId "glossary") gets
   * the scripted glossary block. */
  function scriptBriefsAndGlossary(): { invocations: RunnerInvocation[] } {
    const invocations: RunnerInvocation[] = [];
    runnerSpy = vi.spyOn(mockRunner, 'run').mockImplementation(async (invocation: RunnerInvocation) => {
      invocations.push(invocation);
      const text = invocation.moduleId === 'glossary' ? glossaryText : briefTextFor(invocation.moduleId);
      return { ok: true, rawOutput: text, text, durationMs: 10, exitCode: 0 };
    });
    return { invocations };
  }

  it('a full run (no --module) briefs every module and then builds .docmap/business/glossary.md from them', async () => {
    const modules = await makeTwoModules();
    await seedTechDocs(modules);
    const { invocations } = scriptBriefsAndGlossary();

    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 };
    const summary = await runBrief({ projectRoot: tmpDir, config, logger, runnerName: 'mock' });

    expect(summary.reports).toHaveLength(2);
    expect(summary.reports.every((r) => r.status === 'generated')).toBe(true);
    expect(summary.glossary).toEqual({ written: true });
    expect(invocations.some((i) => i.moduleId === 'glossary')).toBe(true);

    const written = await readGlossaryDoc(tmpDir);
    expect(written).not.toBeNull();
    expect(written!.frontmatter.kind).toBe('glossary');
    expect(written!.body).toContain('lives in: `orders`');
    expect(written!.body).toContain('lives in: `cart`');
  });

  it('a --module-scoped run does not produce or update glossary.md even though briefs exist', async () => {
    const modules = await makeTwoModules();
    await seedTechDocs(modules);
    const orders = modules.find((m) => m.id === 'orders');
    if (!orders) throw new Error('fixture module "orders" not discovered');
    const { invocations } = scriptBriefsAndGlossary();

    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 };
    const summary = await runBrief({
      projectRoot: tmpDir,
      config,
      logger,
      runnerName: 'mock',
      moduleIds: [orders.id],
    });

    expect(summary.reports).toHaveLength(1);
    expect(summary.reports[0]!.status).toBe('generated');
    expect(summary.glossary).toBeUndefined();
    expect(invocations.some((i) => i.moduleId === 'glossary')).toBe(false);

    const written = await readGlossaryDoc(tmpDir);
    expect(written).toBeNull();
  });

  it('zero successful briefs (every module missing/errored) skips glossary generation, no file written', async () => {
    const modules = await makeTwoModules();
    // Deliberately skip seedTechDocs — with no tech doc on disk every module's brief reports 'missing'.
    void modules;

    runnerSpy = vi.spyOn(mockRunner, 'run').mockImplementation(async (invocation: RunnerInvocation) => {
      const text = 'this call should never happen for a module with no tech doc';
      return { ok: true, rawOutput: text, text, durationMs: 10, exitCode: 0 };
    });

    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 };
    const summary = await runBrief({ projectRoot: tmpDir, config, logger, runnerName: 'mock' });

    expect(summary.reports).toHaveLength(2);
    expect(summary.reports.every((r) => r.status === 'missing')).toBe(true);
    expect(summary.glossary).toEqual({ written: false, reason: 'no briefs available' });
    expect(runnerSpy).not.toHaveBeenCalled();

    const written = await readGlossaryDoc(tmpDir);
    expect(written).toBeNull();
  });
});
