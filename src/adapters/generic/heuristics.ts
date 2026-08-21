const IMPORT_PATTERNS = [
  /import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|\s)use\s+([A-Za-z0-9_\\]+)\s*;/g,
];

export function extractImportTargets(source: string): string[] {
  const targets: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const target = match[1];
      if (target) targets.push(target);
    }
  }
  return targets;
}
