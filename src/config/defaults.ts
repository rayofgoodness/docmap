import { DocmapConfigSchema, type DocmapConfig } from './schema.js';

export function getDefaultConfig(): DocmapConfig {
  return DocmapConfigSchema.parse({});
}
