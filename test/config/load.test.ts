import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { getSectionLabels } from '../../src/utils/lang.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-load-config-'));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('normalizes the "ua" language alias to "uk" so section labels are Ukrainian', async () => {
    await fs.writeFile(
      path.join(projectRoot, 'docmap.config.json'),
      JSON.stringify({ language: 'ua' }),
    );

    const config = await loadConfig({ projectRoot });

    expect(config.language).toBe('uk');
    expect(getSectionLabels(config.language)).toEqual(getSectionLabels('uk'));
    expect(getSectionLabels(config.language).purpose).toBe('Призначення');
  });

  it('leaves "uk" untouched', async () => {
    const config = await loadConfig({ projectRoot, overrides: { language: 'uk' } });
    expect(config.language).toBe('uk');
  });
});
