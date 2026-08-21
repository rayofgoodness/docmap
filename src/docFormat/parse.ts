import matter from 'gray-matter';
import type { z } from 'zod';

export interface ParsedDoc<T> {
  frontmatter: T;
  body: string;
}

export function parseDoc<S extends z.ZodTypeAny>(schema: S, raw: string): ParsedDoc<z.infer<S>> {
  const { data, content } = matter(raw);
  const frontmatter: z.infer<S> = schema.parse(data);
  return { frontmatter, body: content.trim() };
}

export function tryParseDoc<S extends z.ZodTypeAny>(schema: S, raw: string): ParsedDoc<z.infer<S>> | null {
  try {
    return parseDoc(schema, raw);
  } catch {
    return null;
  }
}
