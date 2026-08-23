import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { toExcludeGlobs } from '../../utils/pathFilter.js';

const CONFIG_FILENAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts'];
const CONFIG_GLOB = 'nuxt.config.{ts,js,mjs,mts}';

// Monorepos commonly nest the Nuxt app (and therefore its config) a directory or two below the
// repo root — e.g. `apps/web/nuxt.config.ts` or `web/nuxt.config.ts`. Only these two shallow shapes
// are searched (depth <= 2); a config nested any deeper falls back to the generic adapter, same as
// today. Full multi-app-in-one-repo support (picking the *right* app among several) is out of scope
// here — see iteration 4's "peers" concept for that.
const NESTED_CONFIG_GLOBS = [`*/${CONFIG_GLOB}`, `apps/*/${CONFIG_GLOB}`];

/**
 * Finds the path to the project's nuxt.config.*, checking the project root first and then a couple
 * of common monorepo layouts (see NESTED_CONFIG_GLOBS). When multiple nested configs match, the
 * first in sorted order is used — a deliberate minimal choice, not real multi-app disambiguation.
 */
export async function findNuxtConfigPath(projectRoot: string, exclude: string[] = []): Promise<string | null> {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(projectRoot, filename);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  const matches = await fg(NESTED_CONFIG_GLOBS, {
    cwd: projectRoot,
    ignore: toExcludeGlobs(exclude),
    onlyFiles: true,
  });
  if (matches.length === 0) return null;
  const [first] = matches.sort();
  return first ? path.join(projectRoot, first) : null;
}

/** Resolves Nuxt 4's default app-code root: `app/` if present, else the project root (legacy layout). */
export async function resolveAppRoot(projectRoot: string): Promise<string> {
  const appDir = path.join(projectRoot, 'app');
  try {
    const stat = await fs.stat(appDir);
    if (stat.isDirectory()) return appDir;
  } catch {
    // no app/ dir — legacy srcDir at project root
  }
  return projectRoot;
}

/** Extracts string-literal layer paths from an `extends: [...]` array in nuxt.config source (heuristic, regex-based). */
export function findExtendsLayers(configSource: string): string[] {
  const extendsMatch = configSource.match(/extends\s*:\s*\[([^\]]*)\]/);
  if (!extendsMatch?.[1]) return [];
  const layers: string[] = [];
  const stringPattern = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = stringPattern.exec(extendsMatch[1])) !== null) {
    if (match[1]) layers.push(match[1]);
  }
  return layers;
}
