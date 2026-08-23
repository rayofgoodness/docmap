import { loadConfig } from '../config/load.js';
import { runVerify, writeVerifyReport } from '../core/verify.js';
import type { RunnerName } from '../types.js';
import { createLogger } from '../utils/logger.js';

export interface VerifyOptions {
  projectRoot: string;
  module?: string[];
  runner?: RunnerName;
  json?: boolean;
  strict?: boolean;
  dir?: string;
  framework?: string;
  skill?: string;
  since?: string;
  against?: string;
}

export async function verifyCommand(options: VerifyOptions): Promise<void> {
  const logger = createLogger();
  const config = await loadConfig({
    projectRoot: options.projectRoot,
    overrides: {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.framework ? { framework: options.framework as never } : {}),
      ...(options.dir ? { scanDir: options.dir } : {}),
      ...(options.skill ? { skill: options.skill } : {}),
    },
  });

  const { frameworkName, reports } = await runVerify({
    projectRoot: options.projectRoot,
    config,
    logger,
    runnerName: config.runner,
    moduleIds: options.module,
    strict: options.strict,
    sinceRef: options.since,
    against: options.against,
  });

  // Both --json and human mode produce the .md report — --json only changes what's printed to stdout.
  const reportPath = await writeVerifyReport(options.projectRoot, reports, new Date());

  if (options.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    const missing = reports.filter((r) => r.status === 'missing').length;
    const unchanged = reports.filter((r) => r.status === 'unchanged').length;
    const verified = reports.filter((r) => r.status === 'verified' && !r.error).length;
    const errored = reports.filter((r) => Boolean(r.error)).length;

    for (const r of reports) {
      const verdictPart = r.verdict ? ` verdict=${r.verdict}` : '';
      const errorPart = r.error ? ` error=${r.error}` : '';
      logger.info(`${r.status.padEnd(10)} ${r.name} (${r.moduleId})${verdictPart}${errorPart}`);
    }

    logger.info(
      `\nDone. framework=${frameworkName} missing=${missing} unchanged=${unchanged} verified=${verified} errors=${errored}`,
    );
    logger.info(`Report written to ${reportPath}`);
  }

  const hasBreaking = reports.some((r) => r.verdict === 'BREAKING');
  const hasChangedStrict = Boolean(options.strict) && reports.some((r) => r.verdict === 'CHANGED');
  const hasError = reports.some((r) => Boolean(r.error));

  if (hasBreaking || hasChangedStrict || hasError) {
    process.exitCode = 1;
  }
}
