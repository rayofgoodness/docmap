import type { ModuleDescriptor } from '../adapters/types.js';
import { hashFile, hashString } from '../utils/hash.js';

export async function computeModuleFingerprint(module: ModuleDescriptor): Promise<string> {
  const sorted = [...module.files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const parts: string[] = [];
  for (const file of sorted) {
    const contentHash = await hashFile(file.absPath);
    parts.push(`${file.relPath}\0${contentHash}`);
  }
  return `sha256:${hashString(parts.join('\n'))}`;
}
