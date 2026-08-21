import matter from 'gray-matter';

/** js-yaml's dumper throws on `undefined` values — strip them so optional fields serialize as absent keys. */
function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined) as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v !== undefined) result[key] = pruneUndefined(v);
    }
    return result as T;
  }
  return value;
}

export function renderDoc(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(`${body.trim()}\n`, pruneUndefined(frontmatter));
}
