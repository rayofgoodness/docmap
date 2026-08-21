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

// A whitelist of "code" extensions always lags behind whatever language/format a project actually
// uses (this adapter's whole point is to be a fallback for "other languages"). Blocklisting known
// binary/asset types instead means any text-based format — code, markdown docs, yaml/shell deploy
// scripts, sql migrations, whatever — is documentable by default.
const BINARY_EXTENSIONS = new Set([
  '.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg', '.icns', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg', '.flac',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.o', '.a', '.class', '.jar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.sqlite3',
  '.lock',
]);

// A top-level directory with this many (or more) immediate subdirectories reads as a *container* of
// modules (src/, app/, ...) rather than a single cohesive module — Nest/Laravel/generic backends
// commonly put every feature under one such directory. Below the threshold it stays one flat module,
// which is what small/simple projects (and this adapter's own fixtures) expect.
const SUBMODULE_SPLIT_THRESHOLD = 3;

function isDocumentable(relPath: string): boolean {
  return !BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function slugify(relPath: string): string {
  return relPath.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

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

function buildModule(id: string, name: string, rootPath: string, relRootPath: string, files: SourceFileRef[]): ModuleDescriptor | null {
  const elements = files.filter((f) => isDocumentable(f.relPath)).map(toElement);
  // A directory with files but nothing documentable (e.g. a "public" folder that's just a favicon)
  // isn't a module worth generating docs for — skip it rather than emitting an empty "Немає." doc.
  if (elements.length === 0) return null;
  return { id, name, rootPath, relRootPath: toPosixPath(relRootPath), framework: 'generic', elements, relations: [], files };
}

async function resolveModuleDirs(ctx: DiscoveryContext): Promise<string[]> {
  const entries = await fs.readdir(ctx.projectRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.') && !ctx.config.exclude.includes(name));
}

async function listImmediateSubdirs(dirAbsPath: string, exclude: string[]): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dirAbsPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.') && !exclude.includes(name));
}

export const genericAdapter: FrameworkAdapter = {
  name: 'generic',

  async detect(): Promise<boolean> {
    return true;
  },

  async discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]> {
    const { projectRoot, config } = ctx;
    const dirs = await resolveModuleDirs(ctx);
    const modules: ModuleDescriptor[] = [];

    for (const dir of dirs) {
      const rootPath = path.join(projectRoot, dir);
      const subDirNames = await listImmediateSubdirs(rootPath, config.exclude);

      if (subDirNames.length < SUBMODULE_SPLIT_THRESHOLD) {
        const files = await listFiles(rootPath, config.exclude, config.include);
        const module = buildModule(slugify(dir), dir, rootPath, dir, files);
        if (module) modules.push(module);
        continue;
      }

      // Container directory: one module per immediate subdirectory (recursing exactly one level —
      // a feature's own dto/entities/tests subfolders stay part of that feature, not new modules),
      // plus a module for any bootstrap files sitting directly in the container itself.
      const rootFiles = await listFiles(rootPath, config.exclude, config.include);
      const looseFiles = rootFiles.filter((f) => !f.relPath.includes('/'));
      const looseModule = buildModule(slugify(dir), dir, rootPath, dir, looseFiles);
      if (looseModule) modules.push(looseModule);

      for (const sub of subDirNames) {
        const subRootPath = path.join(rootPath, sub);
        const subFiles = await listFiles(subRootPath, config.exclude, config.include);
        const subRelRoot = `${dir}/${sub}`;
        const subModule = buildModule(slugify(subRelRoot), subRelRoot, subRootPath, subRelRoot, subFiles);
        if (subModule) modules.push(subModule);
      }
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
        if (!file) continue;

        let source: string;
        try {
          source = await fs.readFile(file.absPath, 'utf8');
        } catch {
          continue;
        }

        for (const target of extractImportTargets(source)) {
          if (!target.startsWith('.') && !target.startsWith('/')) continue;
          const resolvedAbs = path.resolve(path.dirname(file.absPath), target);
          // A container's own "loose files" module and its per-subdirectory modules can have nested
          // rootPaths (e.g. "src" and "src/availability") — pick the most specific (longest) match so
          // an import into a submodule doesn't get mis-attributed to its parent container module.
          const targetModule = modules
            .filter((m) => m.id !== module.id && resolvedAbs.startsWith(m.rootPath + path.sep))
            .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
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
