import { cosmiconfig } from 'cosmiconfig';
import { DocmapConfigSchema, type DocmapConfig } from './schema.js';

export interface LoadConfigOptions {
  projectRoot: string;
  overrides?: Partial<DocmapConfig>;
}

// Aliases for language codes that mean the same thing to users but aren't recognized
// by src/utils/lang.ts's section-label catalog. Kept minimal and explicit on purpose.
const LANGUAGE_ALIASES: Record<string, string> = {
  ua: 'uk',
};

export async function loadConfig({ projectRoot, overrides }: LoadConfigOptions): Promise<DocmapConfig> {
  const explorer = cosmiconfig('docmap', {
    searchPlaces: [
      'docmap.config.json',
      'docmap.config.js',
      'docmap.config.mjs',
      'docmap.config.ts',
      '.docmaprc',
      '.docmaprc.json',
    ],
  });

  const result = await explorer.search(projectRoot);
  const raw = { ...(result?.config ?? {}), ...(overrides ?? {}) };
  const parsed = DocmapConfigSchema.parse(raw);
  const language = LANGUAGE_ALIASES[parsed.language] ?? parsed.language;
  return { ...parsed, language };
}
