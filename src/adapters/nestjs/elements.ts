import type { ElementDescriptor, ElementKind, SourceFileRef } from '../types.js';

const SUFFIX_KIND: Record<string, ElementKind> = {
  controller: 'controller',
  service: 'service',
  module: 'module',
  guard: 'guard',
  interceptor: 'interceptor',
  pipe: 'pipe',
  dto: 'dto',
  entity: 'entity',
  repository: 'repository',
  gateway: 'gateway',
  resolver: 'resolver',
  middleware: 'middleware',
};

/** "availability.controller.spec.ts" -> controller; "update.dto.ts" -> dto; falls back to "file". */
export function classifyElementKind(fileName: string): ElementKind {
  const withoutExt = fileName.replace(/\.(ts|tsx|js)$/i, '');
  const parts = withoutExt.split('.');
  if (parts.length < 2) return 'file';

  let suffix = parts[parts.length - 1]!.toLowerCase();
  if ((suffix === 'spec' || suffix === 'test') && parts.length > 2) {
    suffix = parts[parts.length - 2]!.toLowerCase();
  }
  return SUFFIX_KIND[suffix] ?? 'file';
}

export function toNestElement(file: SourceFileRef): ElementDescriptor {
  const fileName = file.relPath.split('/').pop()!;
  return {
    id: file.relPath,
    kind: classifyElementKind(fileName),
    name: fileName,
    files: [file],
  };
}
