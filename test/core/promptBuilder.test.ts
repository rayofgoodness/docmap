import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModulePrompt } from '../../src/core/promptBuilder.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { ModuleDescriptor, SourceFileRef } from '../../src/adapters/types.js';

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
      elements: [{ id: 'index.ts', kind: 'file', name: 'index.ts', files: [textFile] }],
      relations: [],
      files: [binaryFile, textFile],
    };

    const prompt = await buildModulePrompt(module, getDefaultConfig());

    expect(prompt).toContain('index.ts');
    expect(prompt).toContain('export const run');
    expect(prompt).not.toContain('favicon.ico');
  });

  it('produces a clean, valid prompt for a module with no documentable elements', async () => {
    const binaryFile = await writeFile('favicon.ico', Buffer.from([0x00, 0xff, 0xfe]));
    const module: ModuleDescriptor = {
      id: 'public',
      name: 'public',
      rootPath: tmpDir,
      relRootPath: 'public',
      framework: 'generic',
      elements: [],
      relations: [],
      files: [binaryFile],
    };

    const prompt = await buildModulePrompt(module, getDefaultConfig());

    expect(prompt).toContain('(no files)');
    expect(prompt).not.toContain('favicon.ico');
  });
});
