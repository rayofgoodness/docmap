import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModuleDescriptor, RelationDescriptor } from '../types.js';
import { extractImportTargets } from '../generic/heuristics.js';
import { findOwningModule, resolveAliasedImport } from '../../utils/moduleImportResolution.js';

const FETCH_CALL_PATTERN = /\b(?:\$fetch|useFetch|useLazyFetch)\(\s*['"]([^'"]+)['"]/g;
const STORE_CALL_PATTERN = /\buse([A-Za-z0-9]+)Store\(/g;
const DEFINE_STORE_PATTERN = /defineStore\(\s*['"]([^'"]+)['"]/;

function stripExt(absPath: string): string {
  return absPath.replace(/\.(js|ts|jsx|tsx|vue|mjs|cjs)$/, '');
}

interface StoreLocation {
  moduleId: string;
  elementId: string;
}

export async function resolveNuxt4Relations(
  modules: ModuleDescriptor[],
  appRoot: string,
  projectRoot: string,
): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];
  // Store/server code isn't confined to the root `stores`/`server` modules — a layer builds its own
  // `layer_<name>__stores`/`layer_<name>__server` modules, and those must participate in relation
  // matching exactly like the root ones do. So collect every module that actually holds elements of
  // the relevant kind, rather than looking up a single hardcoded module id.
  const serverModules = modules.filter((m) => m.elements.some((e) => e.kind === 'server-route'));
  const storeModules = modules.filter((m) => m.elements.some((e) => e.kind === 'store'));

  const storeIdByLowerName = new Map<string, StoreLocation>(); // e.g. "cart" -> owning module + element id
  for (const storesModule of storeModules) {
    for (const element of storesModule.elements) {
      if (element.kind !== 'store') continue;
      const file = element.files[0];
      if (!file) continue;
      try {
        const content = await fs.readFile(file.absPath, 'utf8');
        const match = content.match(DEFINE_STORE_PATTERN);
        if (match?.[1]) {
          storeIdByLowerName.set(match[1].toLowerCase(), { moduleId: storesModule.id, elementId: element.id });
        }
      } catch {
        // unreadable store file — skip
      }
    }
  }

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
      const fromId = `${module.id}::${element.id}`;
      const importedAbsPaths = new Set<string>();

      for (const target of extractImportTargets(source)) {
        const resolved = resolveAliasedImport(target, path.dirname(file.absPath), appRoot, projectRoot);
        if (!resolved) continue;
        importedAbsPaths.add(stripExt(resolved));
        const owner = findOwningModule(modules, resolved);
        if (!owner || owner.id === module.id) continue;
        relations.push({
          type: 'import',
          fromId,
          toId: owner.id,
          toModule: owner.id,
          detail: target,
          confidence: 'heuristic',
        });
      }

      if (serverModules.length > 0 && !serverModules.includes(module)) {
        FETCH_CALL_PATTERN.lastIndex = 0;
        let fetchMatch: RegExpExecArray | null;
        while ((fetchMatch = FETCH_CALL_PATTERN.exec(source)) !== null) {
          const url = fetchMatch[1];
          if (!url) continue;
          for (const serverModule of serverModules) {
            const route = serverModule.elements.find((e) => e.kind === 'server-route' && e.summaryHints?.[0] === url);
            if (route) {
              relations.push({
                type: 'api-call',
                fromId,
                toId: `${serverModule.id}::${route.id}`,
                toModule: serverModule.id,
                detail: url,
                confidence: 'heuristic',
              });
              break;
            }
          }
        }
      }

      if (storeModules.length > 0 && !storeModules.includes(module)) {
        STORE_CALL_PATTERN.lastIndex = 0;
        let storeMatch: RegExpExecArray | null;
        while ((storeMatch = STORE_CALL_PATTERN.exec(source)) !== null) {
          const candidate = storeMatch[1]?.toLowerCase();
          const storeLocation = candidate ? storeIdByLowerName.get(candidate) : undefined;
          if (!storeLocation) continue;
          // An explicit `import ... from '~/stores/x'` already recorded the same dependency above —
          // the call-site relation only adds signal for stores pulled in via Nuxt auto-import.
          const owningModule = modules.find((m) => m.id === storeLocation.moduleId);
          const storeFile = owningModule?.elements.find((e) => e.id === storeLocation.elementId)?.files[0];
          if (storeFile && importedAbsPaths.has(stripExt(storeFile.absPath))) continue;
          relations.push({
            type: 'store',
            fromId,
            toId: `${storeLocation.moduleId}::${storeLocation.elementId}`,
            toModule: storeLocation.moduleId,
            detail: `use${storeMatch[1]}Store()`,
            confidence: 'heuristic',
          });
        }
      }
    }
  }

  return relations;
}
