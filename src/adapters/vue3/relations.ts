import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModuleDescriptor, RelationDescriptor } from '../types.js';
import { extractImportTargets } from '../generic/heuristics.js';
import { findOwningModule, resolveAliasedImport } from '../../utils/moduleImportResolution.js';

const STORE_CALL_PATTERN = /\buse([A-Za-z0-9]+)Store\(/g;
const DEFINE_STORE_PATTERN = /defineStore\(\s*['"]([^'"]+)['"]/;

function extractBracketedArray(source: string, key: string): string | null {
  const keyMatch = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(source);
  if (!keyMatch) return null;
  const start = keyMatch.index + keyMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function splitTopLevelObjects(arrayContent: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(arrayContent.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

interface RouteRef {
  path: string | null;
  componentImportPath: string | null; // dynamic import() specifier
  componentIdentifier: string | null; // static identifier, e.g. `component: HomeView`
}

function extractRoutes(routerSource: string): RouteRef[] {
  const routesArray = extractBracketedArray(routerSource, 'routes');
  if (!routesArray) return [];

  return splitTopLevelObjects(routesArray).map((obj) => {
    const path = /path\s*:\s*['"]([^'"]+)['"]/.exec(obj)?.[1] ?? null;
    const dynamicImport = /component\s*:\s*\(\s*\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/.exec(obj)?.[1] ?? null;
    const staticIdentifier = dynamicImport
      ? null
      : /component\s*:\s*([A-Za-z_$][\w$]*)/.exec(obj)?.[1] ?? null;
    return { path, componentImportPath: dynamicImport, componentIdentifier: staticIdentifier };
  });
}

function stripExt(absPath: string): string {
  return absPath.replace(/\.(js|ts|jsx|tsx|vue|mjs|cjs)$/, '');
}

/** Normalizes a store id or call-site name for matching: lowercases and strips `-`/`_` so a
 * kebab-case `defineStore('checkout-payment')` matches the auto-imported call-site name
 * `useCheckoutPaymentStore()`, whose PascalCase segment lowercases to `checkoutpayment`. */
function normalizeStoreKey(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, '');
}

function extractDefaultImportBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const pattern = /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) bindings.set(match[1]!, match[2]!);
  return bindings;
}

export async function resolveVue3Relations(
  modules: ModuleDescriptor[],
  appRoot: string,
  projectRoot: string,
): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];
  const storesModule = modules.find((m) => m.id === 'stores');
  const routerModule = modules.find((m) => m.id === 'router');

  const storeIdByLowerName = new Map<string, string>();
  if (storesModule) {
    for (const element of storesModule.elements) {
      const file = element.files[0];
      if (!file) continue;
      try {
        const content = await fs.readFile(file.absPath, 'utf8');
        const match = content.match(DEFINE_STORE_PATTERN);
        if (match?.[1]) storeIdByLowerName.set(normalizeStoreKey(match[1]), element.id);
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

      if (storesModule && module.id !== 'stores') {
        STORE_CALL_PATTERN.lastIndex = 0;
        let storeMatch: RegExpExecArray | null;
        while ((storeMatch = STORE_CALL_PATTERN.exec(source)) !== null) {
          const candidate = storeMatch[1] ? normalizeStoreKey(storeMatch[1]) : undefined;
          const storeElementId = candidate ? storeIdByLowerName.get(candidate) : undefined;
          if (!storeElementId) continue;
          // An explicit `import ... from '@/stores/x'` already recorded the same dependency above —
          // the call-site relation only adds signal for stores pulled in via auto-import.
          const storeFile = storesModule.elements.find((e) => e.id === storeElementId)?.files[0];
          if (storeFile && importedAbsPaths.has(stripExt(storeFile.absPath))) continue;
          relations.push({
            type: 'store',
            fromId,
            toId: `stores::${storeElementId}`,
            toModule: 'stores',
            detail: `use${storeMatch[1]}Store()`,
            confidence: 'heuristic',
          });
        }
      }

      if (routerModule && module.id === 'router') {
        const defaultImports = extractDefaultImportBindings(source);
        for (const route of extractRoutes(source)) {
          const specifier = route.componentImportPath
            ?? (route.componentIdentifier ? defaultImports.get(route.componentIdentifier) : undefined);
          if (!specifier) continue;
          const resolved = resolveAliasedImport(specifier, path.dirname(file.absPath), appRoot, projectRoot);
          if (!resolved) continue;
          const owner = findOwningModule(modules, resolved);
          if (!owner) continue;

          const ownerElement = owner.elements.find((e) => {
            const ef = e.files[0];
            return ef && (ef.absPath === resolved || ef.absPath.startsWith(`${resolved}.`));
          });
          relations.push({
            type: 'route',
            fromId,
            toId: ownerElement ? `${owner.id}::${ownerElement.id}` : owner.id,
            toModule: owner.id,
            detail: route.path ? `${route.path} -> ${specifier}` : specifier,
            confidence: 'heuristic',
          });
        }
      }
    }
  }

  return relations;
}
