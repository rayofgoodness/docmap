import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getElementDocPath,
  getModuleDocPath,
  readModuleDoc,
  writeModuleDoc,
} from '../../src/core/docWriter.js';
import type { ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-writer-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function frontmatter(overrides: Partial<ModuleFrontmatter> = {}): ModuleFrontmatter {
  return {
    docmap_version: 1,
    kind: 'module',
    id: 'mod',
    name: 'mod',
    framework: 'generic',
    path: 'mod',
    status: 'implemented',
    language: 'en',
    fingerprint: 'sha256:x',
    generated_at: '2026-08-20T00:00:00.000Z',
    generated_by: { runner: 'mock' },
    elements: [],
    dependencies: [],
    tags: [],
    ...overrides,
  };
}

describe('docWriter', () => {
  it('writes and reads back a module doc', async () => {
    await writeModuleDoc(tmpDir, { relRootPath: 'mod' }, frontmatter(), '## Purpose\nhi');
    const result = await readModuleDoc(tmpDir, { relRootPath: 'mod' });
    expect(result?.frontmatter.fingerprint).toBe('sha256:x');
    expect(result?.body).toContain('## Purpose');
  });

  it('returns null for a module with no doc yet', async () => {
    const result = await readModuleDoc(tmpDir, { relRootPath: 'nope' });
    expect(result).toBeNull();
  });

  it('rejects a relRootPath that escapes the .docmap root', () => {
    expect(() => getModuleDocPath(tmpDir, { relRootPath: '../../etc' })).toThrow(/traversal/);
  });

  it('rejects an element id that escapes the .docmap root', () => {
    expect(() =>
      getElementDocPath(tmpDir, { relRootPath: 'mod' }, { id: '../../../etc/passwd' }),
    ).not.toThrow(); // slugified, so traversal chars become underscores rather than escaping
  });
});
