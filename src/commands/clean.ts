import fs from 'node:fs/promises';
import { getDocmapRoot } from '../core/docWriter.js';
import { createLogger } from '../utils/logger.js';

export interface CleanOptions {
  projectRoot: string;
  yes?: boolean;
}

export async function cleanCommand(options: CleanOptions): Promise<void> {
  const logger = createLogger();
  if (!options.yes) {
    logger.error('Refusing to delete .docmap/ without --yes');
    process.exitCode = 1;
    return;
  }
  await fs.rm(getDocmapRoot(options.projectRoot), { recursive: true, force: true });
  logger.info('Removed .docmap/');
}
