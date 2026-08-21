import path from 'node:path';
import type { DiscoveryContext, FrameworkAdapter, ModuleDescriptor, RelationDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { listFilesUnderDir } from '../../utils/fileListing.js';
import { isDocumentable } from '../../utils/documentable.js';
import { slugify } from '../../utils/slug.js';
import { detectNestJS } from './detect.js';
import { findModuleTsFiles, readModuleClassName } from './moduleFiles.js';
import { toNestElement } from './elements.js';
import { extractModuleImports } from './moduleDecorator.js';

interface NestModuleMeta {
  moduleTsAbsPath: string;
  [key: string]: unknown;
}

export const nestjsAdapter: FrameworkAdapter = {
  name: 'nestjs',

  async detect(ctx: DiscoveryContext): Promise<boolean> {
    return detectNestJS(ctx.projectRoot);
  },

  async discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]> {
    const { projectRoot, config } = ctx;
    const moduleTsFiles = await findModuleTsFiles(projectRoot, config.exclude);

    // Multiple *.module.ts in the same directory is unusual — keep the first, deterministically.
    const moduleTsByDir = new Map<string, string>();
    for (const file of moduleTsFiles) {
      if (!moduleTsByDir.has(file.dirAbsPath)) moduleTsByDir.set(file.dirAbsPath, file.absPath);
    }

    // Process deepest directories first so a nested module's own files are claimed before its
    // parent module directory would otherwise swallow them as "loose" files of its own.
    const dirs = [...moduleTsByDir.keys()].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length,
    );

    const claimed = new Set<string>();
    const modules: ModuleDescriptor[] = [];

    for (const dir of dirs) {
      const allFiles = await listFilesUnderDir(dir, { exclude: config.exclude, include: config.include });
      const unclaimed = allFiles.filter((f) => !claimed.has(f.absPath));
      for (const f of unclaimed) claimed.add(f.absPath);

      const files = unclaimed.filter((f) => isDocumentable(f.relPath));
      if (files.length === 0) continue;

      const moduleTsAbsPath = moduleTsByDir.get(dir)!;
      const relRootPath = path.relative(projectRoot, dir);
      const name = (await readModuleClassName(moduleTsAbsPath)) ?? path.basename(dir);

      const metadata: NestModuleMeta = { moduleTsAbsPath };
      modules.push({
        id: slugify(relRootPath),
        name,
        rootPath: dir,
        relRootPath: toPosixPath(relRootPath),
        framework: 'nestjs',
        elements: files.map(toNestElement),
        relations: [],
        files,
        metadata,
      });
    }

    modules.sort((a, b) => a.relRootPath.localeCompare(b.relRootPath));
    return modules;
  },

  async resolveRelations(modules: ModuleDescriptor[], ctx: DiscoveryContext): Promise<RelationDescriptor[]> {
    const byModuleTsAbsPath = new Map(
      modules.map((m) => [(m.metadata as NestModuleMeta).moduleTsAbsPath, m]),
    );
    const relations: RelationDescriptor[] = [];

    for (const module of modules) {
      const { moduleTsAbsPath } = module.metadata as NestModuleMeta;
      const imports = await extractModuleImports(moduleTsAbsPath);
      const baseDir = path.dirname(moduleTsAbsPath);
      const fromRelId = toPosixPath(path.relative(module.rootPath, moduleTsAbsPath));

      for (const { identifier, specifier } of imports) {
        if (!specifier.startsWith('.')) continue; // an npm package (@nestjs/config, ...), not a local module
        const resolved = path.resolve(baseDir, specifier);

        // Local module imports conventionally point straight at the *.module.ts file (no extension);
        // fall back to a directory match in case of a barrel import (`from './availability'`).
        const target = byModuleTsAbsPath.get(`${resolved}.ts`) ?? modules.find((m) => m.rootPath === resolved);
        if (!target || target.id === module.id) continue;

        const toRelId = toPosixPath(
          path.relative(target.rootPath, (target.metadata as NestModuleMeta).moduleTsAbsPath),
        );

        relations.push({
          type: 'di',
          fromId: `${module.id}::${fromRelId}`,
          toId: `${target.id}::${toRelId}`,
          toModule: target.id,
          detail: `imports ${identifier}`,
          confidence: 'deterministic',
        });
      }
    }

    ctx.logger.debug(`nestjs adapter: resolved ${relations.length} cross-module relations`);
    return relations;
  },
};
