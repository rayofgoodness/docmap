import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModulePrompt, splitIntoBatches } from '../../src/core/promptBuilder.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { ElementDescriptor, ModuleDescriptor, RelationDescriptor, SourceFileRef } from '../../src/adapters/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-prompt-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: Buffer | string): Promise<SourceFileRef> {
  const absPath = path.join(tmpDir, relPath);
  await fs.writeFile(absPath, content);
  const stat = await fs.stat(absPath);
  return { absPath, relPath, sizeBytes: stat.size };
}

function elementOf(file: SourceFileRef): ElementDescriptor {
  return { id: file.relPath, kind: 'file', name: file.relPath, files: [file] };
}

describe('buildModulePrompt', () => {
  it('excerpts only element files, not every file kept for fingerprinting', async () => {
    // A binary asset (e.g. favicon.ico) can end up in module.files for fingerprint purposes without
    // being classified as a documentable element — it must never be read as prompt "source" content.
    const binaryFile = await writeFile('favicon.ico', Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]));
    const textFile = await writeFile('index.ts', 'export const run = () => 1;');

    const module: ModuleDescriptor = {
      id: 'public',
      name: 'public',
      rootPath: tmpDir,
      relRootPath: 'public',
      framework: 'generic',
      elements: [elementOf(textFile)],
      relations: [],
      files: [binaryFile, textFile],
    };

    const config = getDefaultConfig();
    const [batch] = splitIntoBatches(module, config.maxFilesPerPrompt);
    const prompt = await buildModulePrompt(module, config, batch!);

    expect(prompt).toContain('index.ts');
    expect(prompt).toContain('export const run');
    expect(prompt).not.toContain('favicon.ico');
  });

  it('produces a clean, valid prompt for a module with no documentable elements', async () => {
    const module: ModuleDescriptor = {
      id: 'public',
      name: 'public',
      rootPath: tmpDir,
      relRootPath: 'public',
      framework: 'generic',
      elements: [],
      relations: [],
      files: [],
    };

    const config = getDefaultConfig();
    const [batch] = splitIntoBatches(module, config.maxFilesPerPrompt);
    const prompt = await buildModulePrompt(module, config, batch!);

    expect(prompt).toContain('(no files)');
  });

  it('includes skill instructions when provided', async () => {
    const module: ModuleDescriptor = {
      id: 'm',
      name: 'm',
      rootPath: tmpDir,
      relRootPath: 'm',
      framework: 'generic',
      elements: [],
      relations: [],
      files: [],
    };
    const config = getDefaultConfig();
    const [batch] = splitIntoBatches(module, config.maxFilesPerPrompt);
    const prompt = await buildModulePrompt(module, config, batch!, 'Always write in a formal tone.');

    expect(prompt).toContain('Always write in a formal tone.');
  });

  it('deduplicates and caps the module-level relationship summary', async () => {
    const relations: RelationDescriptor[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'import',
      fromId: `m::file${i}.ts`,
      toId: 'stores',
      toModule: 'stores',
      detail: 'useCartStore()',
      confidence: 'heuristic',
    }));
    const module: ModuleDescriptor = {
      id: 'm',
      name: 'm',
      rootPath: tmpDir,
      relRootPath: 'm',
      framework: 'generic',
      elements: [],
      relations,
      files: [],
    };
    const config = getDefaultConfig();
    const [batch] = splitIntoBatches(module, config.maxFilesPerPrompt);
    const prompt = await buildModulePrompt(module, config, batch!);

    // 60 identical (type, target, detail) relations collapse to a single summary line, not 60.
    const occurrences = prompt.split('useCartStore()').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('splitIntoBatches', () => {
  it('keeps a small module in a single batch that includes the body request', () => {
    const files = ['a.ts', 'b.ts'].map((n) => ({ absPath: n, relPath: n, sizeBytes: 1 }));
    const module: ModuleDescriptor = {
      id: 'm',
      name: 'm',
      rootPath: '/x',
      relRootPath: 'm',
      framework: 'generic',
      elements: files.map(elementOf),
      relations: [],
      files,
    };
    const batches = splitIntoBatches(module, 20);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ includeBody: true, totalBatches: 1 });
    expect(batches[0]!.elements).toHaveLength(2);
  });

  it('splits a large module into batches of maxPerBatch, only the first carrying the body request', () => {
    const files = Array.from({ length: 45 }, (_, i) => ({ absPath: `f${i}.ts`, relPath: `f${i}.ts`, sizeBytes: 1 }));
    const module: ModuleDescriptor = {
      id: 'm',
      name: 'm',
      rootPath: '/x',
      relRootPath: 'm',
      framework: 'generic',
      elements: files.map(elementOf),
      relations: [],
      files,
    };
    const batches = splitIntoBatches(module, 20);
    expect(batches.map((b) => b.elements.length)).toEqual([20, 20, 5]);
    expect(batches.map((b) => b.includeBody)).toEqual([true, false, false]);
    expect(batches.every((b) => b.totalBatches === 3)).toBe(true);
  });
});
