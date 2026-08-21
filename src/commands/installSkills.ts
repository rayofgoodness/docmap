import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';

export type SkillAgent = 'claude' | 'codex' | 'gemini' | 'all';

export interface InstallSkillsOptions {
  projectRoot: string;
  agent: SkillAgent;
}

function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

export async function installSkillsCommand(options: InstallSkillsOptions): Promise<void> {
  const logger = createLogger();
  const packageRoot = getPackageRoot();
  const skillsSrc = path.join(packageRoot, 'skills');
  const agents: SkillAgent[] = options.agent === 'all' ? ['claude', 'codex', 'gemini'] : [options.agent];

  for (const agent of agents) {
    if (agent === 'claude') {
      const dest = path.join(options.projectRoot, '.claude', 'skills', 'docmap');
      await fs.mkdir(dest, { recursive: true });
      await fs.cp(path.join(skillsSrc, 'claude-code', 'docmap'), dest, { recursive: true });
      logger.info(`Installed Claude Code skill -> ${dest}`);
    } else if (agent === 'codex') {
      const destDir = path.join(options.projectRoot, '.codex', 'prompts');
      await fs.mkdir(destDir, { recursive: true });
      await fs.copyFile(path.join(skillsSrc, 'codex', 'docmap.prompt.md'), path.join(destDir, 'docmap.md'));
      logger.info(`Installed Codex prompt -> ${path.join(destDir, 'docmap.md')}`);
    } else if (agent === 'gemini') {
      const dest = path.join(options.projectRoot, '.gemini', 'extensions', 'docmap');
      await fs.mkdir(dest, { recursive: true });
      await fs.cp(path.join(skillsSrc, 'gemini', 'docmap-extension'), dest, { recursive: true });
      logger.info(`Installed Gemini CLI extension -> ${dest}`);
    }
  }
}
