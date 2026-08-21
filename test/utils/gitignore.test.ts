import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignoreEntry } from '../../src/utils/gitignore.js';
import { createLogger } from '../../src/utils/logger.js';

let projectRoot: string;
const logger = createLogger();

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-gitignore-'));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('ensureGitignoreEntry', () => {
  it('creates .gitignore with the entry when none exists', async () => {
    await ensureGitignoreEntry(projectRoot, '.docmap/', logger);
    const content = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(content).toBe('.docmap/\n');
  });

  it('appends the entry to an existing .gitignore missing a trailing newline', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/');
    await ensureGitignoreEntry(projectRoot, '.docmap/', logger);
    const content = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(content).toBe('node_modules/\n.docmap/\n');
  });

  it('is a no-op when an equivalent entry already exists (with or without slashes)', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n/.docmap\n');
    await ensureGitignoreEntry(projectRoot, '.docmap/', logger);
    const content = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(content).toBe('node_modules/\n/.docmap\n');
  });
});
