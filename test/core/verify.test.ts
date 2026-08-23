import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildVerifyPrompt, parseVerifyOutput, VERIFY_END, VERIFY_START } from '../../src/core/verify.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { ElementDescriptor, ModuleDescriptor, SourceFileRef } from '../../src/adapters/types.js';

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
