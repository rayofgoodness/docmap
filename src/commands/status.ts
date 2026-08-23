import type { DiscoveryContext } from '../adapters/types.js';
import { loadConfig } from '../config/load.js';
import { discoverProject } from '../core/discovery.js';
import { computeModuleFingerprint } from '../core/fingerprint.js';
import { readBriefDoc, readModuleDoc } from '../core/docWriter.js';
import { createLogger } from '../utils/logger.js';
import { createConcurrencyLimiter } from '../core/concurrency.js';

const STATUS_FINGERPRINT_CONCURRENCY = 8;

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
  /** Status of the localized business brief (`docmap brief`) for this module — 'missing' when no brief
   * file exists yet; 'up-to-date' when the brief's source_fingerprint matches the tech doc's current
   * fingerprint AND the tech doc itself is up to date; 'stale' otherwise (the brief doesn't match its
   * tech doc, or the tech doc itself changed since). */
  briefStatus: DocStatus;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const logger = createLogger();
  const config = await loadConfig({
    projectRoot: options.projectRoot,
    overrides: options.dir ? { scanDir: options.dir } : undefined,
  });
  const ctx: DiscoveryContext = { projectRoot: options.projectRoot, config, logger };
  const { modules } = await discoverProject(ctx);

  const limit = createConcurrencyLimiter(STATUS_FINGERPRINT_CONCURRENCY);
  const reports: ModuleStatusReport[] = await Promise.all(
    modules.map((module) =>
      limit(async (): Promise<ModuleStatusReport> => {
        const existing = await readModuleDoc(options.projectRoot, module);
        let status: DocStatus;
        if (!existing) {
          status = 'missing';
        } else {
          const fingerprint = await computeModuleFingerprint(module);
          status = existing.frontmatter.fingerprint === fingerprint ? 'up-to-date' : 'stale';
        }

        const briefDoc = await readBriefDoc(options.projectRoot, module);
        let briefStatus: DocStatus;
        if (!briefDoc) {
          briefStatus = 'missing';
        } else if (!existing) {
          // A brief exists but its tech doc doesn't (orphaned) — nothing it could validly match.
          briefStatus = 'stale';
        } else {
          const techFingerprint = existing.frontmatter.fingerprint ?? null;
          const matchesTechDoc = briefDoc.frontmatter.source_fingerprint === techFingerprint;
          briefStatus = matchesTechDoc && status === 'up-to-date' ? 'up-to-date' : 'stale';
        }

        return { moduleId: module.id, name: module.name, status, briefStatus };
      }),
    ),
  );

  if (options.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const r of reports) {
    logger.info(`${r.status.padEnd(12)} ${r.briefStatus.padEnd(12)} ${r.name} (${r.moduleId})`);
  }
}
