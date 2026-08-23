import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGlossary,
  buildGlossaryExcerpt,
  buildGlossaryPrompt,
  type GlossaryBriefInput,
} from '../../src/core/glossary.js';
import { BODY_END, BODY_START } from '../../src/core/markers.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { getSectionLabels } from '../../src/utils/lang.js';
import { writeBriefDoc, readGlossaryDoc } from '../../src/core/docWriter.js';
import type { BriefFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { ModuleDescriptor } from '../../src/adapters/types.js';
import type { AgentRunner, RunnerInvocation, RunnerResult } from '../../src/runners/types.js';

function makeModule(id: string): ModuleDescriptor {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    relRootPath: id,
    framework: 'generic',
    elements: [],
    relations: [],
    files: [],
  };
}

describe('buildGlossaryExcerpt', () => {
  const labels = getSectionLabels('en');

  it('extracts only the "What this module does" and "Key scenarios" sections', () => {
    const body = [
      '## What this module does',
      'Orders lets shoppers place and cancel orders.',
      '',
      '## Key scenarios',
      '- A shopper cancels an order before it ships.',
      '',
      '## Business rules',
      'I1: An order can only be cancelled while pending or on-hold.',
      '',
      '## What to check after changes',
      'I1: Create an order, cancel it, confirm it moves to cancelled.',
      '',
      '## Dependency risks',
      '- (no other modules currently depend on this one)',
    ].join('\n');

    const excerpt = buildGlossaryExcerpt(body, labels);

    expect(excerpt).toContain('Orders lets shoppers place and cancel orders.');
    expect(excerpt).toContain('A shopper cancels an order before it ships.');
    expect(excerpt).not.toContain('Business rules');
    expect(excerpt).not.toContain('Dependency risks');
  });

  it('falls back to the whole body when the expected headings are absent', () => {
    const body = 'Some hand-edited brief with no standard headings at all.';
    expect(buildGlossaryExcerpt(body, labels)).toBe(body);
  });

  it('truncates an oversized excerpt with a visible marker, bounding the prompt regardless of brief length', () => {
    const huge = 'x'.repeat(5000);
    const body = `## What this module does\n${huge}`;

    const excerpt = buildGlossaryExcerpt(body, labels);

    expect(excerpt.length).toBeLessThan(huge.length);
    expect(excerpt).toContain('...[truncated]');
  });
});

describe('buildGlossaryPrompt', () => {
  it('includes every module id, its excerpt, and the BODY_START/BODY_END output contract', () => {
    const briefs: GlossaryBriefInput[] = [
      { module: makeModule('orders'), excerpt: '## What this module does\nOrders stuff.' },
      { module: makeModule('cart'), excerpt: '## What this module does\nCart stuff.' },
    ];

    const prompt = buildGlossaryPrompt(briefs, getSectionLabels('en'), 'en');

    expect(prompt).toContain('module-id: orders');
    expect(prompt).toContain('module-id: cart');
    expect(prompt).toContain('Orders stuff.');
    expect(prompt).toContain('Cart stuff.');
    expect(prompt).toContain(BODY_START);
    expect(prompt).toContain(BODY_END);
  });
});

describe('buildGlossary', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-glossary-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
    return { ok: true, rawOutput: '', text: '', durationMs: 10, exitCode: 0, ...overrides };
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

  function makeBriefFrontmatter(module: string): BriefFrontmatter {
    return {
      docmap_version: 1,
      kind: 'brief',
      module,
      language: 'en',
      source_fingerprint: `sha256:${module}-fp`,
      generated_at: '2026-01-01T00:00:00.000Z',
      generated_by: { runner: 'mock' },
    };
  }

  const glossaryText = [
    BODY_START,
    '- **order** — A purchase a shopper makes. — lives in: `orders`',
    '- **cart** — Items a shopper is about to buy. — lives in: `cart`',
    BODY_END,
  ].join('\n');

  it('skips with no runner call and writes nothing when none of the given modules has a brief on disk', async () => {
    const orders = makeModule('orders');
    const { runner, invocations } = fakeRunner([runnerResult({ text: glossaryText })]);

    const result = await buildGlossary({
      projectRoot: tmpDir,
      modules: [orders],
      config: getDefaultConfig(),
      runner,
    });

    expect(result).toEqual({ written: false, reason: 'no briefs available' });
    expect(invocations).toHaveLength(0);
    expect(await readGlossaryDoc(tmpDir)).toBeNull();
  });

  it('aggregates every on-disk brief into one prompt and writes the parsed glossary block', async () => {
    const orders = makeModule('orders');
    const cart = makeModule('cart');
    await writeBriefDoc(
      tmpDir,
      orders,
      makeBriefFrontmatter('orders'),
      '## What this module does\nOrders lets shoppers place and cancel orders.\n\n## Key scenarios\n- A shopper places an order.',
    );
    await writeBriefDoc(
      tmpDir,
      cart,
      makeBriefFrontmatter('cart'),
      '## What this module does\nCart holds items before checkout.\n\n## Key scenarios\n- A shopper adds an item to the cart.',
    );

    const { runner, invocations } = fakeRunner([runnerResult({ text: glossaryText })]);

    const result = await buildGlossary({
      projectRoot: tmpDir,
      modules: [orders, cart],
      config: getDefaultConfig(),
      runner,
    });

    expect(result).toEqual({ written: true });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.prompt).toContain('Orders lets shoppers place and cancel orders.');
    expect(invocations[0]!.prompt).toContain('Cart holds items before checkout.');

    const written = await readGlossaryDoc(tmpDir);
    expect(written).not.toBeNull();
    expect(written!.frontmatter.kind).toBe('glossary');
    expect(written!.body).toContain('lives in: `orders`');
    expect(written!.body).toContain('lives in: `cart`');
  });

  it('skips modules without a brief on disk (e.g. this run\'s missing/errored ones) rather than erroring', async () => {
    const orders = makeModule('orders');
    const broken = makeModule('broken');
    await writeBriefDoc(
      tmpDir,
      orders,
      makeBriefFrontmatter('orders'),
      '## What this module does\nOrders lets shoppers place and cancel orders.',
    );
    // `broken` has no brief on disk at all — simulates a module whose brief was 'missing' or 'error' this run.

    const { runner, invocations } = fakeRunner([runnerResult({ text: glossaryText })]);

    const result = await buildGlossary({
      projectRoot: tmpDir,
      modules: [orders, broken],
      config: getDefaultConfig(),
      runner,
    });

    expect(result).toEqual({ written: true });
    expect(invocations[0]!.prompt).not.toContain('module-id: broken');
  });

  it('surfaces a parse failure as a reason and writes no glossary file', async () => {
    const orders = makeModule('orders');
    await writeBriefDoc(tmpDir, orders, makeBriefFrontmatter('orders'), '## What this module does\nOrders.');

    const { runner } = fakeRunner([
      runnerResult({ text: 'chatty response with no BODY markers at all' }),
      runnerResult({ text: 'still no markers on retry' }),
    ]);

    const result = await buildGlossary({
      projectRoot: tmpDir,
      modules: [orders],
      config: { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 },
      runner,
    });

    expect(result.written).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(await readGlossaryDoc(tmpDir)).toBeNull();
  });
});
