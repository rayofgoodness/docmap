import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

export async function detectMagento2(projectRoot: string): Promise<boolean> {
  try {
    const composerRaw = await fs.readFile(path.join(projectRoot, 'composer.json'), 'utf8');
    const composer = JSON.parse(composerRaw);
    const deps = { ...composer.require, ...composer['require-dev'] };
    if (Object.keys(deps).some((name) => name.startsWith('magento/framework') || name === 'magento/product-community-edition')) {
      return true;
    }
  } catch {
    // no composer.json or unparsable — fall through to other signals
  }

  try {
    await fs.access(path.join(projectRoot, 'app', 'etc', 'env.php'));
    return true;
  } catch {
    return false;
  }
}

export interface ModuleDirInfo {
  absPath: string;
  relPath: string;
}

export async function findModuleDirs(projectRoot: string, exclude: string[]): Promise<ModuleDirInfo[]> {
  const registrationFiles = await fg('**/registration.php', {
    cwd: projectRoot,
    ignore: exclude.map((e) => `**/${e}/**`),
  });

  const dirs: ModuleDirInfo[] = [];
  for (const relFile of registrationFiles) {
    const absFile = path.join(projectRoot, relFile);
    let content: string;
    try {
      content = await fs.readFile(absFile, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('ComponentRegistrar::MODULE')) continue;
    const relDir = path.dirname(relFile);
    dirs.push({ absPath: path.dirname(absFile), relPath: relDir });
  }
  return dirs;
}
