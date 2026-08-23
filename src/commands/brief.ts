import { loadConfig } from '../config/load.js';
import { runBrief } from '../core/brief.js';
import type { RunnerName } from '../types.js';
import { createLogger } from '../utils/logger.js';

export interface BriefOptions {
  projectRoot: string;
  module?: string[];
  runner?: RunnerName;
  lang?: string;
  dir?: string;
  framework?: string;
}

export async function briefCommand(options: BriefOptions): Promise<void> {
  const logger = createLogger();
  const config = await loadConfig({
    projectRoot: options.projectRoot,
    overrides: {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.lang ? { language: options.lang } : {}),
      ...(options.framework ? { framework: options.framework as never } : {}),
      ...(options.dir ? { scanDir: options.dir } : {}),
    },
  });

  const { frameworkName, reports } = await runBrief({
    projectRoot: options.projectRoot,
    config,
    logger,
    runnerName: config.runner,
    moduleIds: options.module,
  });

  for (const r of reports) {
    const errorPart = r.error ? ` error=${r.error}` : '';
    logger.info(`${r.status.padEnd(10)} ${r.name} (${r.moduleId})${errorPart}`);
  }

  const missing = reports.filter((r) => r.status === 'missing').length;
  const unchanged = reports.filter((r) => r.status === 'unchanged').length;
  const generated = reports.filter((r) => r.status === 'generated').length;
  const errored = reports.filter((r) => r.status === 'error').length;

  logger.info(
    `\nDone. framework=${frameworkName} generated=${generated} unchanged=${unchanged} missing=${missing} errors=${errored}`,
  );

  if (errored > 0) process.exitCode = 1;
}
