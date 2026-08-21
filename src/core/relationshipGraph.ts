import type { ModuleDescriptor } from '../adapters/types.js';

function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function buildMermaidGraph(modules: ModuleDescriptor[]): string {
  const lines = ['graph LR'];
  const moduleIds = new Set(modules.map((m) => m.id));
  const seenEdges = new Set<string>();

  for (const module of modules) {
    lines.push(`  ${mermaidId(module.id)}["${module.name}"]`);
  }

  for (const module of modules) {
    for (const rel of module.relations) {
      const target = rel.toModule;
      if (!target || !moduleIds.has(target) || target === module.id) continue;
      const edgeKey = `${module.id}->${target}:${rel.type}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      lines.push(`  ${mermaidId(module.id)} -->|${rel.type}| ${mermaidId(target)}`);
    }
  }

  return lines.join('\n');
}
