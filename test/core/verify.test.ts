import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildVerifyPrompt,
  parseVerifyOutput,
  resolveAgainstDoc,
  runVerify,
  VERIFY_END,
  VERIFY_START,
} from '../../src/core/verify.js';
import { genericAdapter } from '../../src/adapters/generic/index.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { getDocmapRoot } from '../../src/core/docWriter.js';
import { renderDoc } from '../../src/docFormat/render.js';
import { createLogger } from '../../src/utils/logger.js';
import type { ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { DiscoveryContext, ElementDescriptor, ModuleDescriptor, SourceFileRef } from '../../src/adapters/types.js';

describe('parseVerifyOutput', () => {
  it('parses a fully well-formed response', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'BREAKING',
      '',
      '## Invariants',
      'I1: VIOLATED — cancellation is now allowed from any status, not just pending/on-hold.',
      'I2: KEPT — discount cap check is unchanged.',
      '',
      '## Undocumented',
      '- Orders can now be auto-refunded after cancellation, which is not documented anywhere.',
      VERIFY_END,
    ].join('\n');

    const parsed = parseVerifyOutput(text);
    expect(parsed).toEqual({
      summary: 'BREAKING',
      invariants: [
        { id: 'I1', verdict: 'VIOLATED', note: 'cancellation is now allowed from any status, not just pending/on-hold.' },
        { id: 'I2', verdict: 'KEPT', note: 'discount cap check is unchanged.' },
      ],
      undocumented: ['Orders can now be auto-refunded after cancellation, which is not documented anywhere.'],
    });
  });

  it('returns null when the VERIFY_START/END block is missing entirely', () => {
    const text = '## Summary\nCOMPATIBLE\n## Invariants\nI1: KEPT — fine.\n## Undocumented\n(none)';
    expect(parseVerifyOutput(text)).toBeNull();
  });

  it('returns null when only VERIFY_START is present (no closing marker)', () => {
    const text = `${VERIFY_START}\n## Summary\nCOMPATIBLE\n`;
    expect(parseVerifyOutput(text)).toBeNull();
  });

  it('returns null when the Summary line is missing', () => {
    const text = [VERIFY_START, '## Invariants', '(none documented)', '## Undocumented', '(none)', VERIFY_END].join('\n');
    expect(parseVerifyOutput(text)).toBeNull();
  });

  it('returns null when the Summary value is garbled / not one of the three known words', () => {
    const text = [VERIFY_START, '## Summary', 'PROBABLY_FINE', VERIFY_END].join('\n');
    expect(parseVerifyOutput(text)).toBeNull();
  });

  it('tolerates a plain hyphen as the verdict/justification separator', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'CHANGED',
      '## Invariants',
      'I1: CHANGED - the rule now allows on-hold in addition to pending.',
      '## Undocumented',
      '(none)',
      VERIFY_END,
    ].join('\n');

    const parsed = parseVerifyOutput(text);
    expect(parsed?.invariants).toEqual([
      { id: 'I1', verdict: 'CHANGED', note: 'the rule now allows on-hold in addition to pending.' },
    ]);
  });

  it('tolerates a plain colon as the verdict/justification separator', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'COMPATIBLE',
      '## Invariants',
      'I1: KEPT: nothing changed here.',
      '## Undocumented',
      '(none)',
      VERIFY_END,
    ].join('\n');

    const parsed = parseVerifyOutput(text);
    expect(parsed?.invariants).toEqual([{ id: 'I1', verdict: 'KEPT', note: 'nothing changed here.' }]);
  });

  it('tolerates plain whitespace (no punctuation at all) as the verdict/justification separator', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'COMPATIBLE',
      '## Invariants',
      'I1: KEPT the guard clause still checks status',
      '## Undocumented',
      '(none)',
      VERIFY_END,
    ].join('\n');

    const parsed = parseVerifyOutput(text);
    expect(parsed?.invariants).toEqual([
      { id: 'I1', verdict: 'KEPT', note: 'the guard clause still checks status' },
    ]);
  });

  it('parses "(none documented)" for Invariants as an empty list', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'COMPATIBLE',
      '## Invariants',
      '(none documented)',
      '## Undocumented',
      '(none)',
      VERIFY_END,
    ].join('\n');

    const parsed = parseVerifyOutput(text);
    expect(parsed?.invariants).toEqual([]);
    expect(parsed?.undocumented).toEqual([]);
  });

  it('parses "(none)" for Undocumented as an empty list', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'COMPATIBLE',
      '## Invariants',
      'I1: KEPT — still true.',
      '## Undocumented',
      '(none)',
      VERIFY_END,
    ].join('\n');

    expect(parseVerifyOutput(text)?.undocumented).toEqual([]);
  });

  it('parses multiple Undocumented bullets', () => {
    const text = [
      VERIFY_START,
      '## Summary',
      'CHANGED',
      '## Invariants',
      '(none documented)',
      '## Undocumented',
      '- New bulk-export endpoint with no doc coverage.',
      '- Orders now support partial refunds.',
      VERIFY_END,
    ].join('\n');

    expect(parseVerifyOutput(text)?.undocumented).toEqual([
      'New bulk-export endpoint with no doc coverage.',
      'Orders now support partial refunds.',
    ]);
  });
});

describe('buildVerifyPrompt', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-verify-prompt-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeModule(): Promise<ModuleDescriptor> {
    const absPath = path.join(tmpDir, 'orders.ts');
    await fs.writeFile(absPath, 'export function cancelOrder(order) { return true; }');
    const stat = await fs.stat(absPath);
    const file: SourceFileRef = { absPath, relPath: 'orders.ts', sizeBytes: stat.size };
    const element: ElementDescriptor = { id: 'orders.ts', kind: 'file', name: 'orders.ts', files: [file] };
    return {
      id: 'orders',
      name: 'Orders',
      rootPath: tmpDir,
      relRootPath: 'orders',
      framework: 'generic',
      elements: [element],
      relations: [],
      files: [file],
    };
  }

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
      fingerprint: 'sha256:old',
      generated_at: '2026-01-01T00:00:00.000Z',
      generated_by: { runner: 'mock' },
      elements: [],
      invariants,
      dependencies: [],
      dependents: [],
      tags: [],
    };
  }

  it('includes the old doc invariant ids explicitly and the current source excerpt', async () => {
    const module = await makeModule();
    const config = getDefaultConfig();
    const oldDoc = {
      frontmatter: makeFrontmatter([
        { id: 'I1', text: 'An order can only be cancelled while pending or on-hold.' },
      ]),
      body: '## Business Logic\nOrders can be cancelled.\n\n## Invariants\n1. An order can only be cancelled while pending or on-hold.',
    };

    const prompt = await buildVerifyPrompt(module, config, oldDoc);

    expect(prompt).toContain('I1: An order can only be cancelled while pending or on-hold.');
    expect(prompt).toContain('=== OLD DOCUMENTATION (baseline) ===');
    expect(prompt).toContain(oldDoc.body);
    expect(prompt).toContain('=== CURRENT SOURCE ===');
    expect(prompt).toContain('orders.ts');
    expect(prompt).toContain('cancelOrder');
    expect(prompt).toContain(VERIFY_START);
    expect(prompt).toContain(VERIFY_END);
  });

  it('handles the empty-invariants-old-doc case explicitly', async () => {
    const module = await makeModule();
    const config = getDefaultConfig();
    const oldDoc = {
      frontmatter: makeFrontmatter([]),
      body: '## Business Logic\nOrders can be cancelled.',
    };

    const prompt = await buildVerifyPrompt(module, config, oldDoc);

    expect(prompt).toContain('had no "## Invariants" section');
    expect(prompt).toContain('(none documented)');
  });

  it('notes omitted files when the module exceeds maxFilesPerPrompt', async () => {
    const module = await makeModule();
    const extraAbs = path.join(tmpDir, 'extra.ts');
    await fs.writeFile(extraAbs, 'export const extra = 1;');
    const stat = await fs.stat(extraAbs);
    module.elements.push({
      id: 'extra.ts',
      kind: 'file',
      name: 'extra.ts',
      files: [{ absPath: extraAbs, relPath: 'extra.ts', sizeBytes: stat.size }],
    });

    const config = { ...getDefaultConfig(), maxFilesPerPrompt: 1 };
    const oldDoc = { frontmatter: makeFrontmatter([]), body: 'body' };

    const prompt = await buildVerifyPrompt(module, config, oldDoc);
    expect(prompt).toContain('omitted due to the per-prompt file limit');
  });
});

describe('resolveAgainstDoc', () => {
  let tmpDir: string;
  const logger = createLogger();

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-verify-against-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeFrontmatter(): ModuleFrontmatter {
    return {
      docmap_version: 1,
      kind: 'module',
      id: 'checkout',
      name: 'checkout',
      framework: 'generic',
      path: 'checkout',
      status: 'implemented',
      language: 'en',
      fingerprint: 'sha256:baseline',
      generated_at: '2026-08-01T12:00:00.000Z',
      generated_by: { runner: 'mock' },
      elements: [],
      invariants: [{ id: 'I1', text: 'An order can only be cancelled while pending or on-hold.' }],
      dependencies: [],
      dependents: [],
      tags: [],
    };
  }

  async function writeHistorySnapshot(): Promise<void> {
    const historyDir = path.join(getDocmapRoot(tmpDir), '.history', 'checkout');
    await fs.mkdir(historyDir, { recursive: true });
    await fs.writeFile(
      path.join(historyDir, '2026-08-01-1200.md'),
      renderDoc(makeFrontmatter(), '## Business Logic\nOrders can be cancelled while pending.'),
      'utf8',
    );
  }

  it('resolves a plain forward-slash ".history/..." path under .docmap/.history/', async () => {
    await writeHistorySnapshot();

    const resolved = await resolveAgainstDoc(tmpDir, '.history/checkout/2026-08-01-1200.md');

    expect(resolved.frontmatter.id).toBe('checkout');
    expect(resolved.body).toContain('Orders can be cancelled while pending.');
  });

  it('resolves an equivalent backslash-style ".history\\..." path to the same file (Windows separators)', async () => {
    await writeHistorySnapshot();

    // node:path's `sep` is a plain, mutable exported string — not something toPosixPath's own callers
    // can control at runtime on a POSIX machine, so this simulates the Windows environment the bug
    // actually manifests in without needing a different OS to run the test on.
    const originalSep = path.sep;
    // @ts-expect-error -- `sep` is declared readonly in the type defs but is a plain mutable property
    // at runtime; this is the only way to exercise toPosixPath's Windows branch from a POSIX test host.
    path.sep = '\\';
    try {
      const resolvedBackslash = await resolveAgainstDoc(tmpDir, '.history\\checkout\\2026-08-01-1200.md');
      const resolvedForwardSlash = await resolveAgainstDoc(tmpDir, '.history/checkout/2026-08-01-1200.md');

      expect(resolvedBackslash).toEqual(resolvedForwardSlash);
      expect(resolvedBackslash.frontmatter.id).toBe('checkout');
      expect(resolvedBackslash.body).toContain('Orders can be cancelled while pending.');
    } finally {
      // @ts-expect-error -- see above.
      path.sep = originalSep;
    }
  });

  it('throws a clear error when the baseline file does not exist', async () => {
    await expect(resolveAgainstDoc(tmpDir, '.history/checkout/does-not-exist.md')).rejects.toThrow(
      /--against baseline not found/,
    );
  });
});

describe('runVerify --against scoping', () => {
  let tmpDir: string;
  const logger = createLogger();

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-verify-against-scope-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeOrdersProject(): Promise<ModuleDescriptor> {
    await fs.mkdir(path.join(tmpDir, 'orders'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'orders', 'index.ts'),
      'export function cancelOrder(order) { return order.status === "pending"; }\n',
    );
    const ctx: DiscoveryContext = { projectRoot: tmpDir, config: getDefaultConfig(), logger };
    const modules = await genericAdapter.discoverModules(ctx);
    const orders = modules.find((m) => m.name === 'orders');
    if (!orders) throw new Error('fixture module not discovered');
    return orders;
  }

  it('rejects when --against is set without any --module scoping it', async () => {
    await makeOrdersProject();
    const config = { ...getDefaultConfig(), maxRetries: 0, timeoutMs: 1000 };

    await expect(
      runVerify({ projectRoot: tmpDir, config, logger, runnerName: 'mock', against: 'irrelevant.md' }),
    ).rejects.toThrow(/--against requires --module <id> to scope it to exactly one module/);
  });

  it('rejects when --against is paired with more than one --module', async () => {
    await makeOrdersProject();
    await fs.mkdir(path.join(tmpDir, 'cart'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'cart', 'index.ts'), 'export function addToCart(item) { return true; }\n');
    const config = { ...getDefaultConfig(), maxRetries: 0, timeoutMs: 1000 };

    await expect(
      runVerify({
        projectRoot: tmpDir,
        config,
        logger,
        runnerName: 'mock',
        against: 'irrelevant.md',
        moduleIds: ['orders', 'cart'],
      }),
    ).rejects.toThrow(/--against requires --module <id> to scope it to exactly one module/);
  });

  it('accepts --against when paired with exactly one --module and verifies that module against the baseline', async () => {
    const orders = await makeOrdersProject();

    const historyDir = path.join(getDocmapRoot(tmpDir), '.history', orders.relRootPath);
    await fs.mkdir(historyDir, { recursive: true });
    const frontmatter: ModuleFrontmatter = {
      docmap_version: 1,
      kind: 'module',
      id: 'orders',
      name: 'orders',
      framework: 'generic',
      path: 'orders',
      status: 'implemented',
      language: 'en',
      fingerprint: 'sha256:baseline',
      generated_at: '2026-08-01T12:00:00.000Z',
      generated_by: { runner: 'mock' },
      elements: [],
      invariants: [{ id: 'I1', text: 'An order can only be cancelled while pending or on-hold.' }],
      dependencies: [],
      dependents: [],
      tags: [],
    };
    await fs.writeFile(
      path.join(historyDir, '2026-08-01-1200.md'),
      renderDoc(frontmatter, '## Business Logic\nOrders can be cancelled while pending.'),
      'utf8',
    );

    const config = { ...getDefaultConfig(), maxRetries: 0, timeoutMs: 1000 };
    const summary = await runVerify({
      projectRoot: tmpDir,
      config,
      logger,
      runnerName: 'mock',
      against: '.history/orders/2026-08-01-1200.md',
      moduleIds: ['orders'],
    });

    // No scoping error, exactly the one requested module was targeted, and it was actually verified
    // against the baseline (not skipped as "missing"/"unchanged" — --against always bypasses both
    // the "no doc on disk" and fingerprint-unchanged shortcuts).
    expect(summary.reports).toHaveLength(1);
    expect(summary.reports[0]!.moduleId).toBe('orders');
    expect(summary.reports[0]!.status).toBe('verified');
  });
});
