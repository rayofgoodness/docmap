import { Command } from 'commander';
import { scanCommand } from './commands/scan.js';
import { generateCommand } from './commands/generate.js';
import { statusCommand } from './commands/status.js';
import { initCommand } from './commands/init.js';
import { installSkillsCommand, type SkillAgent } from './commands/installSkills.js';
import { cleanCommand } from './commands/clean.js';
import type { RunnerName } from './types.js';

const program = new Command();

program.name('docmap').description('Generate module-level *.md documentation for a codebase').version('0.1.0');

program
  .command('init')
  .description('Scaffold docmap.config.json and .docmap/ in the target project')
  .option('--lang <lang>', 'documentation language')
  .option('--framework <framework>', 'force a framework adapter (magento2|nuxt4|generic|auto)')
  .action(async (opts) => {
    await initCommand({ projectRoot: process.cwd(), lang: opts.lang, framework: opts.framework });
  });

program
  .command('scan')
  .description('Discover modules and relations without calling any AI agent')
  .option('--framework <framework>', 'force a framework adapter')
  .option('--json', 'output JSON')
  .action(async (opts) => {
    await scanCommand({ projectRoot: process.cwd(), framework: opts.framework, json: opts.json });
  });

program
  .command('generate')
  .description('Discover modules and generate/refresh .docmap/ documentation')
  .option('--module <id>', 'target a specific module id (repeatable)', (val, prev: string[]) => [...prev, val], [])
  .option('--runner <name>', 'agent runner: claude|codex|gemini|mock')
  .option('--lang <lang>', 'documentation language')
  .option('--force', 'ignore fingerprint cache and regenerate everything')
  .option('--dry-run', 'build prompts without calling the agent')
  .option('--concurrency <n>', 'max parallel agent calls', (v) => parseInt(v, 10))
  .option('--fail-fast', 'abort on first module error')
  .option('--model <model>', 'model override passed to the runner')
  .option('--framework <framework>', 'force a framework adapter')
  .action(async (opts) => {
    await generateCommand({
      projectRoot: process.cwd(),
      module: opts.module?.length ? opts.module : undefined,
      runner: opts.runner as RunnerName | undefined,
      lang: opts.lang,
      force: opts.force,
      dryRun: opts.dryRun,
      concurrency: opts.concurrency,
      failFast: opts.failFast,
      model: opts.model,
      framework: opts.framework,
    });
  });

program
  .command('status')
  .description('Show per-module doc status (missing/up-to-date/stale)')
  .option('--json', 'output JSON')
  .action(async (opts) => {
    await statusCommand({ projectRoot: process.cwd(), json: opts.json });
  });

program
  .command('install-skills')
  .description('Copy skill wrappers into the target project')
  .option('--agent <agent>', 'claude|codex|gemini|all', 'all')
  .action(async (opts) => {
    await installSkillsCommand({ projectRoot: process.cwd(), agent: opts.agent as SkillAgent });
  });

program
  .command('clean')
  .description('Remove the .docmap/ directory')
  .option('--yes', 'confirm deletion')
  .action(async (opts) => {
    await cleanCommand({ projectRoot: process.cwd(), yes: opts.yes });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exitCode = 1;
});
