import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { scanCommand } from './commands/scan.js';
import { generateCommand } from './commands/generate.js';
import { statusCommand } from './commands/status.js';
import { verifyCommand } from './commands/verify.js';
import { initCommand } from './commands/init.js';
import { installSkillsCommand, type SkillAgent } from './commands/installSkills.js';
import { cleanCommand } from './commands/clean.js';
import { checkForUpdate, formatUpdateNotice } from './utils/updateCheck.js';
import type { RunnerName } from './types.js';

const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const { name, version } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name: string; version: string };

const program = new Command();

program.name('docmap').description('Generate module-level *.md documentation for a codebase').version(version);

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
  .option('--dir <path>', 'restrict scanning to a subdirectory of the project')
  .option('--json', 'output JSON')
  .action(async (opts) => {
    await scanCommand({ projectRoot: process.cwd(), framework: opts.framework, json: opts.json, dir: opts.dir });
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
  .option('--dir <path>', 'restrict scanning to a subdirectory of the project')
  .option('--skill <path>', 'markdown/SKILL.md file with project-specific documentation instructions')
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
      dir: opts.dir,
      skill: opts.skill,
    });
  });

program
  .command('status')
  .description('Show per-module doc status (missing/up-to-date/stale)')
  .option('--json', 'output JSON')
  .option('--dir <path>', 'restrict scanning to a subdirectory of the project')
  .action(async (opts) => {
    await statusCommand({ projectRoot: process.cwd(), json: opts.json, dir: opts.dir });
  });

program
  .command('verify')
  .description('Compare current source against documented invariants and flag business-logic regressions')
  .option('--module <id>', 'target a specific module id (repeatable)', (val, prev: string[]) => [...prev, val], [])
  .option('--runner <name>', 'agent runner: claude|codex|gemini|mock')
  .option('--json', 'output JSON')
  .option('--strict', 'also fail (exit 1) on CHANGED verdicts, not just BREAKING')
  .option('--dir <path>', 'restrict scanning to a subdirectory of the project')
  .option('--framework <framework>', 'force a framework adapter')
  .option('--skill <path>', 'markdown/SKILL.md file with project-specific documentation instructions')
  .option('--since <ref>', 'focus each stale module\'s prompt on the diff against this git ref')
  .option('--against <path>', 'verify against a specific historical doc version instead of the current one')
  .action(async (opts) => {
    await verifyCommand({
      projectRoot: process.cwd(),
      module: opts.module?.length ? opts.module : undefined,
      runner: opts.runner as RunnerName | undefined,
      json: opts.json,
      strict: opts.strict,
      dir: opts.dir,
      framework: opts.framework,
      skill: opts.skill,
      since: opts.since,
      against: opts.against,
    });
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

const updateAvailable = checkForUpdate({ packageName: name, currentVersion: version });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(`[fatal] ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    const latest = await updateAvailable;
    if (latest) console.error(formatUpdateNotice(name, version, latest, process.stderr.isTTY === true));
  });
