import type { DiscoveryContext } from '../adapters/types.js';
import { loadConfig } from '../config/load.js';
import { discoverProject } from '../core/discovery.js';
import { createLogger } from '../utils/logger.js';

export interface ScanOptions {
  projectRoot: string;
  framework?: string;
  json?: boolean;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const logger = createLogger();
  const config = await loadConfig({
    projectRoot: options.projectRoot,
    overrides: options.framework ? { framework: options.framework as never } : undefined,
  });

  const ctx: DiscoveryContext = { projectRoot: options.projectRoot, config, logger };
  const { frameworkName, modules } = await discoverProject(ctx);

  if (options.json) {
    console.log(JSON.stringify({ framework: frameworkName, modules }, null, 2));
    return;
  }

  logger.info(`Framework: ${frameworkName}`);
  logger.info(`Modules: ${modules.length}`);
  for (const module of modules) {
    logger.info(`\n- ${module.name} (${module.relRootPath})`);
    logger.info(`  elements: ${module.elements.length}, relations: ${module.relations.length}`);
    for (const rel of module.relations) {
      logger.info(`    ${rel.type} [${rel.confidence}] -> ${rel.toModule ?? rel.toId}${rel.detail ? ` (${rel.detail})` : ''}`);
    }
  }
}
