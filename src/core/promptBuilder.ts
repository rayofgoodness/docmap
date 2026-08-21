import fs from 'node:fs/promises';
import type { ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import { BODY_END, BODY_START, ELEMENT_END, elementStartMarker } from './markers.js';

async function readExcerpt(absPath: string, maxBytes: number): Promise<string> {
  try {
    const content = await fs.readFile(absPath, 'utf8');
    if (content.length <= maxBytes) return content;
    return `${content.slice(0, maxBytes)}\n...[truncated]`;
  } catch {
    return '[unreadable]';
  }
}

export async function buildModulePrompt(
  module: ModuleDescriptor,
  config: ResolvedDocmapConfig,
): Promise<string> {
  const files = module.files.slice(0, config.maxFilesPerPrompt);
  const excerpts = await Promise.all(
    files.map(async (f) => ({
      relPath: f.relPath,
      content: await readExcerpt(f.absPath, config.maxFileExcerptBytes),
    })),
  );

  const relationLines = module.relations
    .map((r) => `- ${r.type} (${r.confidence}): ${r.fromId} -> ${r.toId}${r.detail ? ` — ${r.detail}` : ''}`)
    .join('\n');

  const elementLines = module.elements.map((e) => `- ${e.id} (${e.kind})`).join('\n');

  const fileBlocks = excerpts
    .map((e) => `### ${e.relPath}\n\`\`\`\n${e.content}\n\`\`\``)
    .join('\n\n');

  return [
    `You are documenting the "${module.name}" module (framework: ${module.framework}) of a software project.`,
    `Write the documentation in language code "${config.language}".`,
    '',
    'Relations already detected deterministically (do not re-derive these, only describe their business purpose):',
    relationLines || '(none detected)',
    '',
    'Elements in this module:',
    elementLines || '(none)',
    '',
    'Source excerpts:',
    fileBlocks || '(no files)',
    '',
    'Output contract — respond with ONLY the following, no other prose:',
    `1. One module overview block: ${BODY_START}\\n## Purpose\\n...\\n## Responsibilities\\n...\\n## Business Logic\\n...\\n## Inputs / Outputs\\n...\\n## Relationships\\n...\\n${BODY_END}`,
    `2. One block per element listed above: ${elementStartMarker('<element id>')}\\n...\\n${ELEMENT_END}`,
  ].join('\n');
}
