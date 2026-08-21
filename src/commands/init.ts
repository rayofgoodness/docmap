import fs from 'node:fs/promises';
import path from 'node:path';
import { getDefaultConfig } from '../config/defaults.js';
import { getDocmapRoot } from '../core/docWriter.js';
import { createLogger } from '../utils/logger.js';
import { ensureGitignoreEntry } from '../utils/gitignore.js';

export interface InitOptions {
  projectRoot: string;
  lang?: string;
  framework?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const logger = createLogger();
  const configPath = path.join(options.projectRoot, 'docmap.config.json');

  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    logger.warn(`${configPath} already exists — leaving it untouched`);
  } else {
    const config = getDefaultConfig();
    if (options.lang) config.language = options.lang;
    if (options.framework) config.framework = options.framework as typeof config.framework;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    logger.info(`Created ${configPath}`);
  }

  await fs.mkdir(getDocmapRoot(options.projectRoot), { recursive: true });
  await ensureGitignoreEntry(options.projectRoot, '.docmap/', logger);
  logger.info(`Ready. Run "docmap scan" to preview modules, then "docmap generate".`);
}
