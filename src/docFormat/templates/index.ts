import type { ModuleDescriptor } from '../../adapters/types.js';
import { buildMermaidGraph } from '../../core/relationshipGraph.js';

export function buildIndexBody(modules: ModuleDescriptor[]): string {
  const rows = modules
    .map((m) => `| ${m.name} | ${m.framework} | ${m.relRootPath} | ${m.elements.length} |`)
    .join('\n');

  return [
    '## Modules',
    '',
    '| Module | Framework | Path | Elements |',
    '|---|---|---|---|',
    rows || '| _none_ | | | |',
    '',
    '## Relationships',
    '',
    '```mermaid',
    buildMermaidGraph(modules),
    '```',
  ].join('\n');
}
