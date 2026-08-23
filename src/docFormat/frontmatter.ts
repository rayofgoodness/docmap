import { z } from 'zod';

const RelationTypeSchema = z.enum([
  'di', 'event', 'import', 'api-call', 'extends', 'plugin-intercepts', 'route', 'store', 'unknown',
]);

const StatusSchema = z.enum(['planned', 'implemented', 'partial']);

const GeneratedBySchema = z.object({
  runner: z.enum(['claude', 'codex', 'gemini', 'mock']),
  model: z.string().optional(),
});

export const ModuleFrontmatterSchema = z.object({
  docmap_version: z.literal(1),
  kind: z.literal('module'),
  id: z.string(),
  name: z.string(),
  framework: z.string(),
  path: z.string(),
  status: StatusSchema,
  language: z.string(),
  fingerprint: z.string().nullable().optional(),
  generated_at: z.string(),
  generated_by: GeneratedBySchema,
  elements: z.array(z.object({ id: z.string(), path: z.string() })).default([]),
  invariants: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  dependencies: z
    .array(
      z.object({
        module: z.string(),
        type: RelationTypeSchema,
        detail: z.string().optional(),
      }),
    )
    .default([]),
  dependents: z.array(z.object({ module: z.string(), type: RelationTypeSchema })).default([]),
  tags: z.array(z.string()).default([]),
});
export type ModuleFrontmatter = z.infer<typeof ModuleFrontmatterSchema>;

export const ElementFrontmatterSchema = z.object({
  docmap_version: z.literal(1),
  kind: z.literal('element'),
  id: z.string(),
  module: z.string(),
  elementKind: z.string(),
  name: z.string(),
  status: StatusSchema,
  language: z.string(),
  files: z.array(z.string()).default([]),
  fingerprint: z.string().nullable().optional(),
  generated_at: z.string(),
  relations: z
    .array(
      z.object({
        type: RelationTypeSchema,
        to: z.string(),
        confidence: z.enum(['deterministic', 'heuristic']),
        detail: z.string().optional(),
      }),
    )
    .default([]),
});
export type ElementFrontmatter = z.infer<typeof ElementFrontmatterSchema>;

export const IndexFrontmatterSchema = z.object({
  docmap_version: z.literal(1),
  kind: z.literal('index'),
  generated_at: z.string(),
  modules: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      framework: z.string(),
      status: StatusSchema,
    }),
  ),
});
export type IndexFrontmatter = z.infer<typeof IndexFrontmatterSchema>;

export const BriefFrontmatterSchema = z.object({
  docmap_version: z.literal(1),
  kind: z.literal('brief'),
  module: z.string(),
  language: z.string(),
  source_fingerprint: z.string().nullable(),
  generated_at: z.string(),
  generated_by: GeneratedBySchema,
});
export type BriefFrontmatter = z.infer<typeof BriefFrontmatterSchema>;

/**
 * The domain glossary is a single aggregate file over ALL briefs, not per-module — so unlike every
 * other kind here it carries no `module`/`source_fingerprint` id to trace back to. `docmap status`
 * can still detect its presence/absence via `readGlossaryDoc` without needing a dedicated schema
 * field for it.
 */
export const GlossaryFrontmatterSchema = z.object({
  docmap_version: z.literal(1),
  kind: z.literal('glossary'),
  language: z.string(),
  generated_at: z.string(),
  generated_by: GeneratedBySchema,
});
export type GlossaryFrontmatter = z.infer<typeof GlossaryFrontmatterSchema>;
