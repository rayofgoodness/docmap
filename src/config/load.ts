import { cosmiconfig } from 'cosmiconfig';
import { DocmapConfigSchema, type DocmapConfig } from './schema.js';

export interface LoadConfigOptions {
  projectRoot: string;
  overrides?: Partial<DocmapConfig>;
}

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
  return DocmapConfigSchema.parse(raw);
}
