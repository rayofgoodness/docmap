import { describe, expect, it } from 'vitest';
import { isIncluded, toExcludeGlobs } from '../../src/utils/pathFilter.js';

describe('toExcludeGlobs', () => {
  it('expands a bare name to match it as a directory (with contents) or a leaf file, anywhere in the tree', () => {
    expect(toExcludeGlobs(['vendor'])).toEqual(['**/vendor', '**/vendor/**']);
  });

  it('passes an already-glob-like or path-like entry through unchanged', () => {
    expect(toExcludeGlobs(['app/pages/**', '*.generated.ts'])).toEqual(['app/pages/**', '*.generated.ts']);
  });
});

describe('isIncluded', () => {
  it('allows everything when include is empty', () => {
    expect(isIncluded('anything/at/all.ts', [])).toBe(true);
  });

  it('matches a bare name anywhere in the path, mirroring exclude semantics', () => {
    expect(isIncluded('Model/Foo.php', ['Model'])).toBe(true);
    expect(isIncluded('Observer/Bar.php', ['Model'])).toBe(false);
  });

  it('matches an explicit glob pattern', () => {
    expect(isIncluded('app/pages/cart.vue', ['app/pages/**'])).toBe(true);
    expect(isIncluded('app/stores/cart.ts', ['app/pages/**'])).toBe(false);
  });

  it('matches a bare name as a leaf file, not only as a directory', () => {
    expect(isIncluded('index.ts', ['index.ts'])).toBe(true);
    expect(isIncluded('src/index.ts', ['index.ts'])).toBe(true);
    expect(isIncluded('helper.ts', ['index.ts'])).toBe(false);
  });
});
