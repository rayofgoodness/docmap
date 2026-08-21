import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInScope, loadScopeFilters } from '../../src/core/scopeFilter.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-scope-'));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('loadScopeFilters / isInScope', () => {
  it('imposes no restriction when there is no .gitignore and no scanDir', async () => {
    const filters = await loadScopeFilters(projectRoot);
    expect(isInScope(path.join(projectRoot, 'src', 'index.ts'), projectRoot, filters)).toBe(true);
  });

  it('excludes files matched by the project .gitignore', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'dist/\n*.log\n');
    const filters = await loadScopeFilters(projectRoot);
    expect(isInScope(path.join(projectRoot, 'dist', 'bundle.js'), projectRoot, filters)).toBe(false);
    expect(isInScope(path.join(projectRoot, 'debug.log'), projectRoot, filters)).toBe(false);
    expect(isInScope(path.join(projectRoot, 'src', 'index.ts'), projectRoot, filters)).toBe(true);
  });

  it('restricts to files under scanDir when given', async () => {
    const filters = await loadScopeFilters(projectRoot, 'app/pages');
    expect(isInScope(path.join(projectRoot, 'app', 'pages', 'cart.vue'), projectRoot, filters)).toBe(true);
    expect(isInScope(path.join(projectRoot, 'app', 'stores', 'cart.ts'), projectRoot, filters)).toBe(false);
  });

  it('combines gitignore and scanDir restrictions', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'app/pages/generated.vue\n');
    const filters = await loadScopeFilters(projectRoot, 'app/pages');
    expect(isInScope(path.join(projectRoot, 'app', 'pages', 'cart.vue'), projectRoot, filters)).toBe(true);
    expect(isInScope(path.join(projectRoot, 'app', 'pages', 'generated.vue'), projectRoot, filters)).toBe(false);
    expect(isInScope(path.join(projectRoot, 'app', 'stores', 'cart.ts'), projectRoot, filters)).toBe(false);
  });

  it('treats a scanDir that resolves to the project root as no restriction', async () => {
    const filters = await loadScopeFilters(projectRoot, '.');
    expect(isInScope(path.join(projectRoot, 'anywhere', 'file.ts'), projectRoot, filters)).toBe(true);
  });
});
