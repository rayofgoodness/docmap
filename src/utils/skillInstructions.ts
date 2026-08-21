import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Logger } from './logger.js';

/**
 * Loads free-form documentation instructions from a file (e.g. a Claude Code SKILL.md, or any plain
 * markdown/text file) and folds them into every module prompt — house style, tone, what to emphasize,
 * project-specific conventions the deterministic discovery can't know about. YAML frontmatter (if the
 * file has any, as a real SKILL.md does) is stripped; only the body is used as instruction text.
 */
export async function loadSkillInstructions(
  projectRoot: string,
  skillPath: string,
  logger: Logger,
): Promise<string | undefined> {
  const absPath = path.isAbsolute(skillPath) ? skillPath : path.join(projectRoot, skillPath);
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    const { content } = matter(raw);
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    logger.warn(`[skill] could not read "${absPath}" (${(err as Error).message}) — continuing without it`);
    return undefined;
  }
}
