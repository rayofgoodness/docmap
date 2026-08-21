import fs from 'node:fs/promises';
import path from 'node:path';

export async function detectVue3(projectRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const vueVersion = deps.vue;
    if (typeof vueVersion !== 'string') return false;
    // Vue 2 has its own, very different conventions — leave those to the generic adapter. Anything
    // that isn't an explicit 2.x range (including no clear major, e.g. "latest") is assumed 3.x.
    return !/^[\^~]?2\./.test(vueVersion);
  } catch {
    return false;
  }
}

/** Vite-scaffolded Vue 3 apps put app code under src/; fall back to project root for other layouts. */
export async function resolveAppRoot(projectRoot: string): Promise<string> {
  const srcDir = path.join(projectRoot, 'src');
  try {
    const stat = await fs.stat(srcDir);
    if (stat.isDirectory()) return srcDir;
  } catch {
    // no src/ — assume a flat layout at the project root
  }
  return projectRoot;
}
