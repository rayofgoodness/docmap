import fs from 'node:fs/promises';
import path from 'node:path';

export async function detectNestJS(projectRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('@nestjs/core' in deps) return true;
  } catch {
    // no package.json or unparsable — fall through to the other signal
  }

  try {
    await fs.access(path.join(projectRoot, 'nest-cli.json'));
    return true;
  } catch {
    return false;
  }
}
