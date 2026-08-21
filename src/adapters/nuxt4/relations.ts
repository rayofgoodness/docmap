import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModuleDescriptor, RelationDescriptor } from '../types.js';
import { extractImportTargets } from '../generic/heuristics.js';
import { findOwningModule, resolveAliasedImport } from '../../utils/moduleImportResolution.js';

const FETCH_CALL_PATTERN = /\b(?:\$fetch|useFetch|useLazyFetch)\(\s*['"]([^'"]+)['"]/g;
const STORE_CALL_PATTERN = /\buse([A-Za-z0-9]+)Store\(/g;
const DEFINE_STORE_PATTERN = /defineStore\(\s*['"]([^'"]+)['"]/;

export async function resolveNuxt4Relations(
  modules: ModuleDescriptor[],
  appRoot: string,
  projectRoot: string,
): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];
  const serverModule = modules.find((m) => m.id === 'server');
  const storesModule = modules.find((m) => m.id === 'stores');

  const storeIdByLowerName = new Map<string, string>(); // e.g. "cart" -> element id of the store file
  if (storesModule) {
    for (const element of storesModule.elements) {
      const file = element.files[0];
      if (!file) continue;
      try {
        const content = await fs.readFile(file.absPath, 'utf8');
        const match = content.match(DEFINE_STORE_PATTERN);
        if (match?.[1]) storeIdByLowerName.set(match[1].toLowerCase(), element.id);
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

      for (const target of extractImportTargets(source)) {
        const resolved = resolveAliasedImport(target, path.dirname(file.absPath), appRoot, projectRoot);
        if (!resolved) continue;
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

      if (serverModule && module.id !== 'server') {
        FETCH_CALL_PATTERN.lastIndex = 0;
        let fetchMatch: RegExpExecArray | null;
        while ((fetchMatch = FETCH_CALL_PATTERN.exec(source)) !== null) {
          const url = fetchMatch[1];
          if (!url) continue;
          const route = serverModule.elements.find((e) => e.summaryHints?.[0] === url);
          if (route) {
            relations.push({
              type: 'api-call',
              fromId,
              toId: `server::${route.id}`,
              toModule: 'server',
              detail: url,
              confidence: 'heuristic',
            });
          }
        }
      }

      if (storesModule && module.id !== 'stores') {
        STORE_CALL_PATTERN.lastIndex = 0;
        let storeMatch: RegExpExecArray | null;
        while ((storeMatch = STORE_CALL_PATTERN.exec(source)) !== null) {
          const candidate = storeMatch[1]?.toLowerCase();
          const storeElementId = candidate ? storeIdByLowerName.get(candidate) : undefined;
          if (storeElementId) {
            relations.push({
              type: 'unknown',
              fromId,
              toId: `stores::${storeElementId}`,
              toModule: 'stores',
              detail: `use${storeMatch[1]}Store()`,
              confidence: 'heuristic',
            });
          }
        }
      }
    }
  }

  return relations;
}
