import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeModuleFingerprint } from '../../src/core/fingerprint.js';
import type { ModuleDescriptor, SourceFileRef } from '../../src/adapters/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-fp-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<SourceFileRef> {
  const absPath = path.join(tmpDir, relPath);
  await fs.writeFile(absPath, content, 'utf8');
  const stat = await fs.stat(absPath);
  return { absPath, relPath, sizeBytes: stat.size };
}

function toModule(files: SourceFileRef[]): ModuleDescriptor {
  return {
    id: 'm',
    name: 'm',
    rootPath: tmpDir,
    relRootPath: 'm',
    framework: 'generic',
    elements: [],
    relations: [],
    files,
  };
}

describe('computeModuleFingerprint', () => {
  it('is stable across repeated calls', async () => {
    const files = [await writeFile('a.ts', 'a'), await writeFile('b.ts', 'b')];
    const module = toModule(files);
    const first = await computeModuleFingerprint(module);
    const second = await computeModuleFingerprint(module);
    expect(first).toBe(second);
  });

  it('is independent of file ordering', async () => {
    const a = await writeFile('a.ts', 'a');
    const b = await writeFile('b.ts', 'b');
    const forward = await computeModuleFingerprint(toModule([a, b]));
    const reversed = await computeModuleFingerprint(toModule([b, a]));
    expect(forward).toBe(reversed);
  });

  it('changes when a file changes', async () => {
    const files = [await writeFile('a.ts', 'a')];
    const before = await computeModuleFingerprint(toModule(files));
    await writeFile('a.ts', 'a-changed');
    const after = await computeModuleFingerprint(toModule(files));
    expect(before).not.toBe(after);
  });
});
