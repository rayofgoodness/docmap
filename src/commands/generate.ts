import { loadConfig } from '../config/load.js';
import { runGenerate } from '../core/orchestrator.js';
import type { RunnerName } from '../types.js';
import { createLogger } from '../utils/logger.js';

export interface GenerateOptions {
  projectRoot: string;
  module?: string[];
  runner?: RunnerName;
  lang?: string;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  failFast?: boolean;
  model?: string;
  framework?: string;
  dir?: string;
}

export async function generateCommand(options: GenerateOptions): Promise<void> {
  const logger = createLogger();
  const config = await loadConfig({
    projectRoot: options.projectRoot,
    overrides: {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.lang ? { language: options.lang } : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.framework ? { framework: options.framework as never } : {}),
      ...(options.dir ? { scanDir: options.dir } : {}),
    },
  });

  const summary = await runGenerate({
    projectRoot: options.projectRoot,
    config,
    logger,
    runnerName: config.runner,
    moduleIds: options.module,
    force: options.force,
    dryRun: options.dryRun,
    failFast: options.failFast,
  });

  const generated = summary.reports.filter((r) => r.outcome === 'generated').length;
  const skipped = summary.reports.filter((r) => r.outcome === 'skipped-up-to-date').length;
  const errored = summary.reports.filter((r) => r.outcome === 'error').length;
  const dryRun = summary.reports.filter((r) => r.outcome === 'dry-run').length;

  logger.info(
    `\nDone. framework=${summary.frameworkName} generated=${generated} skipped=${skipped} dry-run=${dryRun} errors=${errored}`,
  );

  if (errored > 0) process.exitCode = 1;
}
