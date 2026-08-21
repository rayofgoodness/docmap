import type { ModuleDescriptor } from '../types.js';
import { moduleNameToNamespace } from './moduleXml.js';

export interface NamespaceEntry {
  prefix: string; // e.g. "Vendor\Module"
  moduleId: string;
}

export function buildNamespaceMap(modules: ModuleDescriptor[]): NamespaceEntry[] {
  const entries: NamespaceEntry[] = [];
  for (const module of modules) {
    const magentoName = module.metadata?.magentoModuleName;
    if (typeof magentoName !== 'string') continue;
    entries.push({ prefix: moduleNameToNamespace(magentoName), moduleId: module.id });
  }
  // Longest prefix first so a more specific namespace wins over a shorter accidental match.
  return entries.sort((a, b) => b.prefix.length - a.prefix.length);
}

export interface ResolvedOwner {
  moduleId: string;
  elementId: string;
}

export function resolveOwner(fqcn: string, nsMap: NamespaceEntry[]): ResolvedOwner | null {
  const normalized = fqcn.replace(/^\\/, '');
  for (const entry of nsMap) {
    if (normalized === entry.prefix || normalized.startsWith(`${entry.prefix}\\`)) {
      const remainder = normalized.slice(entry.prefix.length).replace(/^\\/, '');
      if (!remainder) return null;
      return { moduleId: entry.moduleId, elementId: `${remainder.replace(/\\/g, '/')}.php` };
    }
  }
  return null;
}
