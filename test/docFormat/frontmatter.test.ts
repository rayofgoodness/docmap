import { describe, expect, it } from 'vitest';
import { ModuleFrontmatterSchema } from '../../src/docFormat/frontmatter.js';
import { parseDoc, tryParseDoc } from '../../src/docFormat/parse.js';
import { renderDoc } from '../../src/docFormat/render.js';

function validModuleFrontmatter() {
  return {
    docmap_version: 1 as const,
    kind: 'module' as const,
    id: 'vendor_checkoutmodule',
    name: 'Vendor_CheckoutModule',
    framework: 'magento2',
    path: 'app/code/Vendor/CheckoutModule',
    status: 'implemented' as const,
    language: 'en',
    fingerprint: 'sha256:abc',
    generated_at: '2026-08-20T00:00:00.000Z',
    generated_by: { runner: 'mock' as const },
    elements: [],
    dependencies: [],
    tags: [],
  };
}

describe('module frontmatter round-trip', () => {
  it('survives render -> parse unchanged', () => {
    const frontmatter = validModuleFrontmatter();
    const rendered = renderDoc(frontmatter, '## Purpose\nhello');
    const parsed = parseDoc(ModuleFrontmatterSchema, rendered);
    expect(parsed.frontmatter).toMatchObject(frontmatter);
    expect(parsed.body).toBe('## Purpose\nhello');
  });

  it('omits undefined optional fields without throwing', () => {
    const frontmatter = { ...validModuleFrontmatter(), generated_by: { runner: 'mock' as const, model: undefined } };
    expect(() => renderDoc(frontmatter, 'body')).not.toThrow();
  });

  it('rejects an invalid status enum', () => {
    const raw = renderDoc({ ...validModuleFrontmatter(), status: 'bogus' }, 'body');
    expect(tryParseDoc(ModuleFrontmatterSchema, raw)).toBeNull();
  });

  it('rejects a doc missing required fields', () => {
    const raw = renderDoc({ docmap_version: 1, kind: 'module' }, 'body');
    expect(tryParseDoc(ModuleFrontmatterSchema, raw)).toBeNull();
  });
});
