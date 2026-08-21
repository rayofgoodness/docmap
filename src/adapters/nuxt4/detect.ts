import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILENAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts'];

export async function findNuxtConfigPath(projectRoot: string): Promise<string | null> {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(projectRoot, filename);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
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
