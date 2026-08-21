import fs from 'node:fs/promises';
import type { ModuleDescriptor, RelationDescriptor } from '../types.js';
import { extractImportTargets } from '../generic/heuristics.js';
import { resolveOwner, type NamespaceEntry } from './namespace.js';

export async function resolvePhpUseRelations(
  modules: ModuleDescriptor[],
  nsMap: NamespaceEntry[],
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
        const owner = resolveOwner(target, nsMap);
        if (!owner || owner.moduleId === module.id) continue;
        relations.push({
          type: 'import',
          fromId: `${module.id}::${element.id}`,
          toId: `${owner.moduleId}::${owner.elementId}`,
          toModule: owner.moduleId,
          detail: target,
          confidence: 'heuristic',
        });
      }
    }
  }

  return relations;
}
