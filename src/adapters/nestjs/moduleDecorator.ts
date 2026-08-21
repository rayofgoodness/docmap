import fs from 'node:fs/promises';

export interface ModuleImportRef {
  identifier: string;
  specifier: string;
}

function extractImportBindings(source: string): ModuleImportRef[] {
  const bindings: ModuleImportRef[] = [];
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source)) !== null) {
    const names = match[1]!.split(',').map((n) => n.trim()).filter(Boolean);
    for (const name of names) {
      // "Foo as Bar" — the local binding used in the file body is the name after "as".
      const parts = name.split(/\s+as\s+/);
      const localName = (parts[1] ?? parts[0])!.trim();
      bindings.push({ identifier: localName, specifier: match[2]! });
    }
  }
  return bindings;
}

/** Extracts the raw text between the brackets of `key: [ ... ]`, tracking bracket depth for nested calls. */
function extractBracketedArray(source: string, key: string): string | null {
  const keyMatch = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(source);
  if (!keyMatch) return null;
  const start = keyMatch.index + keyMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

/** Extracts the `{ ... }` body of the first `@Module({ ... })` call, tracking brace depth. */
function extractModuleDecoratorBody(source: string): string | null {
  const decoratorMatch = /@Module\s*\(\s*\{/.exec(source);
  if (!decoratorMatch) return null;
  const start = decoratorMatch.index + decoratorMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function extractModuleIdentifiers(arrayContent: string): string[] {
  const pattern = /([A-Za-z_$][A-Za-z0-9_$]*Module)\b/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(arrayContent)) !== null) found.add(match[1]!);
  return [...found];
}

/** Reads a *.module.ts file and returns the local-module identifiers referenced in its `imports: [...]`, each resolved to the import specifier it came from. */
export async function extractModuleImports(moduleTsAbsPath: string): Promise<ModuleImportRef[]> {
  let source: string;
  try {
    source = await fs.readFile(moduleTsAbsPath, 'utf8');
  } catch {
    return [];
  }

  const decoratorBody = extractModuleDecoratorBody(source);
  if (!decoratorBody) return [];

  const importsArrayContent = extractBracketedArray(decoratorBody, 'imports');
  if (!importsArrayContent) return [];

  const identifiers = extractModuleIdentifiers(importsArrayContent);
  const bindingMap = new Map(extractImportBindings(source).map((b) => [b.identifier, b.specifier]));

  const refs: ModuleImportRef[] = [];
  for (const identifier of identifiers) {
    const specifier = bindingMap.get(identifier);
    if (specifier) refs.push({ identifier, specifier });
  }
  return refs;
}
