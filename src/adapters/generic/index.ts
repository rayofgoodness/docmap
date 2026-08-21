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

function isDocumentable(relPath: string): boolean {
  return !BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase());
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
      const elements = files.filter((f) => isDocumentable(f.relPath)).map(toElement);
      // A directory with files but nothing documentable (e.g. a "public" folder that's just a favicon)
      // isn't a module worth generating docs for — skip it rather than emitting an empty "Немає." doc.
      if (elements.length === 0) continue;

      modules.push({
        id: dir.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name: dir,
        rootPath,
        relRootPath: toPosixPath(dir),
        framework: 'generic',
        elements,
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
