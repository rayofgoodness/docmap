import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type {
  DiscoveryContext,
  ElementDescriptor,
  FrameworkAdapter,
  ModuleDescriptor,
  RelationDescriptor,
  SourceFileRef,
} from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { isIncluded, toExcludeGlobs } from '../../utils/pathFilter.js';
import { extractImportTargets } from './heuristics.js';

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue',
  '.php', '.py', '.go', '.rb', '.java', '.cs',
]);

async function listFiles(rootPath: string, exclude: string[], include: string[]): Promise<SourceFileRef[]> {
  const entries = await fg('**/*', {
    cwd: rootPath,
    onlyFiles: true,
    dot: false,
    ignore: toExcludeGlobs(exclude),
  });
  const refs: SourceFileRef[] = [];
  for (const relPath of entries.filter((relPath) => isIncluded(relPath, include))) {
    const absPath = path.join(rootPath, relPath);
    const stat = await fs.stat(absPath);
    refs.push({ absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size });
  }
  return refs;
}

function toElement(file: SourceFileRef): ElementDescriptor {
  return {
    id: file.relPath,
    kind: 'file',
    name: path.basename(file.relPath),
    files: [file],
  };
}

async function resolveModuleDirs(ctx: DiscoveryContext): Promise<string[]> {
  const entries = await fs.readdir(ctx.projectRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.') && !ctx.config.exclude.includes(name));
}

export const genericAdapter: FrameworkAdapter = {
  name: 'generic',

  async detect(): Promise<boolean> {
    return true;
  },

  async discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]> {
    const dirs = await resolveModuleDirs(ctx);
    const modules: ModuleDescriptor[] = [];

    for (const dir of dirs) {
      const rootPath = path.join(ctx.projectRoot, dir);
      const files = await listFiles(rootPath, ctx.config.exclude, ctx.config.include);
      if (files.length === 0) continue;

      modules.push({
        id: dir.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name: dir,
        rootPath,
        relRootPath: toPosixPath(dir),
        framework: 'generic',
        elements: files.filter((f) => TEXT_EXTENSIONS.has(path.extname(f.relPath))).map(toElement),
        relations: [],
        files,
      });
    }

    return modules;
  },

  async resolveRelations(
    modules: ModuleDescriptor[],
    ctx: DiscoveryContext,
  ): Promise<RelationDescriptor[]> {
    const relations: RelationDescriptor[] = [];

    for (const module of modules) {
      for (const element of module.elements) {
        const file = element.files[0];
        if (!file || !TEXT_EXTENSIONS.has(path.extname(file.relPath))) continue;

        let source: string;
        try {
          source = await fs.readFile(file.absPath, 'utf8');
        } catch {
          continue;
        }

        for (const target of extractImportTargets(source)) {
          if (!target.startsWith('.') && !target.startsWith('/')) continue;
          const resolvedAbs = path.resolve(path.dirname(file.absPath), target);
          const targetModule = modules.find(
            (m) => m.id !== module.id && resolvedAbs.startsWith(m.rootPath + path.sep),
          );
          if (!targetModule) continue;

          relations.push({
            type: 'import',
            fromId: `${module.id}::${element.id}`,
            toId: targetModule.id,
            toModule: targetModule.id,
            detail: target,
            confidence: 'heuristic',
          });
        }
      }
    }

    ctx.logger.debug(`generic adapter: resolved ${relations.length} cross-module relations`);
    return relations;
  },
};
