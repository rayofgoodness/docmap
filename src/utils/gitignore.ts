import fs from 'node:fs/promises';
import path from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';
import type { Logger } from './logger.js';

export type { Ignore };

/** Returns null when the project has no root .gitignore — callers should then skip filtering entirely. */
export async function loadGitignore(projectRoot: string): Promise<Ignore | null> {
  try {
    const content = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    return ignoreFactory().add(content);
  } catch {
    return null;
  }
}

function normalizeEntry(line: string): string {
  return line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Idempotently appends `entry` to the project's .gitignore, creating the file if it doesn't exist yet. */
export async function ensureGitignoreEntry(projectRoot: string, entry: string, logger: Logger): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let content = '';
  let fileExists = true;
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    fileExists = false;
  }

  const target = normalizeEntry(entry);
  const alreadyPresent = content.split('\n').some((line) => normalizeEntry(line) === target);
  if (alreadyPresent) return;

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await fs.writeFile(gitignorePath, `${content}${separator}${entry}\n`, 'utf8');
  logger.info(fileExists ? `Added "${entry}" to ${gitignorePath}` : `Created ${gitignorePath} with "${entry}"`);
}
