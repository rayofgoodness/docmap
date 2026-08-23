import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getElementDocPath,
  getModuleDocPath,
  getModuleHistoryDir,
  readModuleDoc,
  snapshotModuleDocHistory,
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
    invariants: [],
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

describe('snapshotModuleDocHistory', () => {
  const module = { relRootPath: 'mod' };

  /** Simulates one `generate` cycle: snapshot whatever doc is currently on disk (a no-op the first
   * time round), then overwrite it — the same order writeModule() in orchestrator.ts uses. */
  async function generateRound(index: number, historyKeep: number): Promise<void> {
    await snapshotModuleDocHistory(tmpDir, module, historyKeep);
    await writeModuleDoc(
      tmpDir,
      module,
      frontmatter({ generated_at: `2026-08-20T00:00:0${index}.000Z`, fingerprint: `sha256:v${index}` }),
      `## Purpose\ngeneration ${index}`,
    );
  }

  it('is a no-op on a first-time generate (no prior doc to snapshot)', async () => {
    await snapshotModuleDocHistory(tmpDir, module, 5);
    await expect(fs.readdir(getModuleHistoryDir(tmpDir, module))).rejects.toThrow();
  });

  it('leaves exactly one history file after generating twice', async () => {
    await generateRound(1, 5);
    await generateRound(2, 5);

    const historyDir = getModuleHistoryDir(tmpDir, module);
    const files = await fs.readdir(historyDir);
    expect(files).toHaveLength(1);

    const snapshotted = await fs.readFile(path.join(historyDir, files[0]!), 'utf8');
    expect(snapshotted).toContain('generation 1');
  });

  it('rotates down to historyKeep files, evicting the oldest snapshot first', async () => {
    const historyKeep = 3;
    // 1 initial write + (historyKeep + 1) overwrites => historyKeep + 1 snapshots taken along the way,
    // which must rotate down to exactly historyKeep, dropping the very first snapshot (generation 1's doc).
    const totalRounds = historyKeep + 2;
    for (let i = 1; i <= totalRounds; i++) {
      await generateRound(i, historyKeep);
    }

    const historyDir = getModuleHistoryDir(tmpDir, module);
    const files = (await fs.readdir(historyDir)).sort();
    expect(files).toHaveLength(historyKeep);

    const contents = await Promise.all(files.map((f) => fs.readFile(path.join(historyDir, f), 'utf8')));
    // Snapshots for generations 1..totalRounds-1 were taken; only the newest `historyKeep` of them
    // (generations totalRounds-historyKeep .. totalRounds-1) should have survived rotation.
    expect(contents.some((c) => c.includes('generation 1'))).toBe(false);
    for (let i = totalRounds - historyKeep; i <= totalRounds - 1; i++) {
      expect(contents.some((c) => c.includes(`generation ${i}`))).toBe(true);
    }
  });

  it('never creates a .history directory when historyKeep is 0', async () => {
    await generateRound(1, 0);
    await generateRound(2, 0);
    await generateRound(3, 0);

    await expect(fs.access(path.join(tmpDir, '.docmap', '.history'))).rejects.toThrow();
  });
});
