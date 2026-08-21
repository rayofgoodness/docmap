import type { SourceFileRef } from '../types.js';
import { listFilesUnderDir } from '../../utils/fileListing.js';

export async function listFilesUnder(
  dirAbsPath: string,
  exclude: string[],
  include: string[] = [],
): Promise<SourceFileRef[]> {
  return listFilesUnderDir(dirAbsPath, {
    exclude,
    include,
    patterns: '**/*.{ts,tsx,js,jsx,mjs,vue}',
  });
}
