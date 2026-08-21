import type { DiscoveryContext } from '../adapters/types.js';
import { loadConfig } from '../config/load.js';
import { discoverProject } from '../core/discovery.js';
import { computeModuleFingerprint } from '../core/fingerprint.js';
import { readModuleDoc } from '../core/docWriter.js';
import { createLogger } from '../utils/logger.js';

export type DocStatus = 'missing' | 'up-to-date' | 'stale';

export interface StatusOptions {
  projectRoot: string;
  json?: boolean;
  dir?: string;
}

export interface ModuleStatusReport {
  moduleId: string;
  name: string;
  status: DocStatus;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const logger = createLogger();
  const config = await loadConfig({
    projectRoot: options.projectRoot,
    overrides: options.dir ? { scanDir: options.dir } : undefined,
  });
  const ctx: DiscoveryContext = { projectRoot: options.projectRoot, config, logger };
  const { modules } = await discoverProject(ctx);

  const reports: ModuleStatusReport[] = [];
  for (const module of modules) {
    const existing = await readModuleDoc(options.projectRoot, module);
    let status: DocStatus;
    if (!existing) {
      status = 'missing';
    } else {
      const fingerprint = await computeModuleFingerprint(module);
      status = existing.frontmatter.fingerprint === fingerprint ? 'up-to-date' : 'stale';
    }
    reports.push({ moduleId: module.id, name: module.name, status });
  }

  if (options.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const r of reports) {
    logger.info(`${r.status.padEnd(12)} ${r.name} (${r.moduleId})`);
  }
}
