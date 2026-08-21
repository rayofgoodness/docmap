import { z } from 'zod';

export const DocmapConfigSchema = z.object({
  framework: z.enum(['magento2', 'nuxt4', 'nestjs', 'vue3', 'generic', 'auto']).default('auto'),
  language: z.string().default('en'),
  scanDir: z.string().optional(),
  skill: z.string().optional(),
  runner: z.enum(['claude', 'codex', 'gemini', 'mock']).default('claude'),
  model: z.string().optional(),
  concurrency: z.number().int().min(1).max(8).default(2),
  include: z.array(z.string()).default([]),
  exclude: z
    .array(z.string())
    .default(['node_modules', 'vendor', '.git', 'dist', 'build', '.docmap']),
  maxFilesPerPrompt: z.number().int().positive().default(20),
  maxFileExcerptBytes: z.number().int().positive().default(4000),
  maxRetries: z.number().int().min(0).default(1),
  timeoutMs: z.number().int().positive().default(120_000),
  elementDocThreshold: z.number().int().min(0).default(1),
});

export type DocmapConfig = z.infer<typeof DocmapConfigSchema>;
export type ResolvedDocmapConfig = DocmapConfig;
