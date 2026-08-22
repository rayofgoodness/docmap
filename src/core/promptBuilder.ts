import fs from 'node:fs/promises';
import type { ElementDescriptor, ModuleDescriptor, RelationDescriptor, SourceFileRef } from '../adapters/types.js';
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

/**
 * An element's files can include non-text assets kept only for fingerprinting — reading one as utf8
 * and stuffing the result into the prompt as "source" has derailed agents into never emitting the
 * output markers at all. Elements are already text-classified by each adapter, so this only ever sees
 * documentable files.
 */
function collectFiles(elements: ElementDescriptor[]): SourceFileRef[] {
  const seen = new Set<string>();
  const files: SourceFileRef[] = [];
  for (const element of elements) {
    for (const file of element.files) {
      if (seen.has(file.absPath)) continue;
      seen.add(file.absPath);
      files.push(file);
    }
  }
  return files;
}

export interface PromptBatch {
  elements: ElementDescriptor[];
  batchIndex: number;
  totalBatches: number;
  /** Only the first batch carries the module-overview request — later batches ask for element blocks only. */
  includeBody: boolean;
}

/** A module with more elements than maxFilesPerPrompt can document is split so every element eventually gets real source-backed documentation, instead of asking one prompt to write hundreds of blocks it was never shown the source for. */
export function splitIntoBatches(module: ModuleDescriptor, maxPerBatch: number): PromptBatch[] {
  const total = module.elements.length;
  if (total === 0) return [{ elements: [], batchIndex: 0, totalBatches: 1, includeBody: true }];

  const totalBatches = Math.ceil(total / maxPerBatch);
  const batches: PromptBatch[] = [];
  for (let i = 0; i < totalBatches; i++) {
    batches.push({
      elements: module.elements.slice(i * maxPerBatch, (i + 1) * maxPerBatch),
      batchIndex: i,
      totalBatches,
      includeBody: i === 0,
    });
  }
  return batches;
}

function relationKey(r: RelationDescriptor): string {
  return `${r.type}|${r.toModule ?? r.toId}|${r.detail ?? ''}`;
}

const MAX_SUMMARY_RELATION_LINES = 40;

/** A relation is recorded per source element — a module with hundreds of elements sharing a few common
 * dependencies (e.g. every page using the same store) produces hundreds of near-duplicate lines. This
 * collapses them to distinct (type, target) pairs for the module-level summary. */
function buildRelationSummary(relations: RelationDescriptor[]): string {
  if (relations.length === 0) return '(none detected)';
  const seen = new Set<string>();
  const deduped: RelationDescriptor[] = [];
  for (const r of relations) {
    const key = relationKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  const shown = deduped.slice(0, MAX_SUMMARY_RELATION_LINES);
  const lines = shown.map(
    (r) => `- ${r.type} (${r.confidence}) -> ${r.toModule ?? r.toId}${r.detail ? `: ${r.detail}` : ''}`,
  );
  if (deduped.length > shown.length) {
    lines.push(`...and ${deduped.length - shown.length} more distinct targets (deduplicated from ${relations.length} raw signals)`);
  }
  return lines.join('\n');
}

function buildElementSection(element: ElementDescriptor, moduleId: string, allRelations: RelationDescriptor[]): string {
  const fromId = `${moduleId}::${element.id}`;
  const ownRelations = allRelations.filter((r) => r.fromId === fromId);
  const relLines = ownRelations
    .map((r) => `  - ${r.type} (${r.confidence}) -> ${r.toModule ?? r.toId}${r.detail ? `: ${r.detail}` : ''}`)
    .join('\n');
  return relLines ? `- ${element.id} (${element.kind})\n${relLines}` : `- ${element.id} (${element.kind})`;
}

export async function buildModulePrompt(
  module: ModuleDescriptor,
  config: ResolvedDocmapConfig,
  batch: PromptBatch,
  instructions?: string,
): Promise<string> {
  const files = collectFiles(batch.elements).slice(0, config.maxFilesPerPrompt);
  const excerpts = await Promise.all(
    files.map(async (f) => ({
      relPath: f.relPath,
      content: await readExcerpt(f.absPath, config.maxFileExcerptBytes),
    })),
  );

  const elementLines = batch.elements.map((e) => buildElementSection(e, module.id, module.relations)).join('\n');
  const fileBlocks = excerpts.map((e) => `### ${e.relPath}\n\`\`\`\n${e.content}\n\`\`\``).join('\n\n');

  const elementTemplate = [
    'Each element block must be detailed documentation of that file, with these four sections (render the headings translated into the documentation language):',
    '  ### Purpose — 2-4 sentences: what the file does and the user-facing behavior it implements.',
    '  ### Data — a bullet list of the concrete data the file works with: every prop, store field, composable return, API response field, route/query param it reads or writes. For each: `name` (type) — what it represents and what it controls. Use the exact identifiers from the source (e.g. `quantity` — number of product units in the cart, drives the stepper and max-stock validation) so a developer searching the docs can find which parameter is responsible for what.',
    '  ### Logic — key business rules, conditions, computed values, and edge cases visible in the source (when a button is hidden, how a discount is computed, limits).',
    '  ### Relationships — which components/stores/composables/API endpoints it uses and what data flows through each (omit the section if none).',
    'Base everything on the actual source excerpts — never invent fields that are not in the code. If an element\'s source was not included in the excerpts, write only what the relations reveal and mark it "(source not shown)" translated into the documentation language.',
  ].join('\n');

  const outputContract = batch.includeBody
    ? [
        `1. One module overview block: ${BODY_START}\\n## Purpose\\n...\\n## Responsibilities\\n...\\n## Business Logic\\n...\\n## Inputs / Outputs\\n...\\n## Relationships\\n...\\n${BODY_END}`,
        `2. One block per element listed above: ${elementStartMarker('<element id>')}\\n...\\n${ELEMENT_END}`,
        elementTemplate,
      ]
    : [
        `Respond with ONLY one block per element listed above — this batch does not need a module overview block (already written from an earlier batch): ${elementStartMarker('<element id>')}\\n...\\n${ELEMENT_END}`,
        elementTemplate,
      ];

  const lines: string[] = [
    `You are documenting the "${module.name}" module (framework: ${module.framework}) of a software project.`,
    `Write the documentation in language code "${config.language}".`,
  ];

  if (instructions) {
    lines.push('', 'Project-specific documentation instructions (follow these for tone, focus, and conventions):', instructions);
  }

  if (batch.totalBatches > 1) {
    lines.push(
      '',
      `This module has ${module.elements.length} elements total, split into ${batch.totalBatches} batches of up to ${config.maxFilesPerPrompt} so every element gets documentation backed by its actual source — this is batch ${batch.batchIndex + 1} of ${batch.totalBatches}. Only write blocks for the elements listed below.`,
    );
  }

  lines.push(
    '',
    'Module-level relationship summary (deduplicated across the whole module — describe business purpose, this is context, not a list to write blocks for):',
    buildRelationSummary(module.relations),
    '',
    `Elements in this ${batch.totalBatches > 1 ? 'batch' : 'module'}:`,
    elementLines || '(none)',
    '',
    'Source excerpts:',
    fileBlocks || '(no files)',
    '',
    'Output contract — respond with ONLY the following, no other prose:',
    ...outputContract,
  );

  return lines.join('\n');
}
