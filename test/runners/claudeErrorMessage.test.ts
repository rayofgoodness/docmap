import { describe, expect, it } from 'vitest';
import { extractErrorMessage } from '../../src/runners/claude.js';

describe('extractErrorMessage', () => {
  it('prefers a non-empty stderr', () => {
    expect(extractErrorMessage('{}', 'permission denied\n')).toBe('permission denied');
  });

  it('falls back to the JSON result field on stdout when stderr is empty', () => {
    const stdout = JSON.stringify({ is_error: true, result: "There's an issue with the selected model." });
    expect(extractErrorMessage(stdout, '')).toBe("There's an issue with the selected model.");
  });

  it('ignores a stdout result field when is_error is not set', () => {
    const stdout = JSON.stringify({ is_error: false, result: 'module docs here' });
    expect(extractErrorMessage(stdout, '')).toBe(stdout);
  });

  it('falls back to a truncated raw stdout snippet when nothing else is available', () => {
    const stdout = 'x'.repeat(600);
    expect(extractErrorMessage(stdout, '')).toBe('x'.repeat(500));
  });

  it('returns undefined when both stdout and stderr are empty', () => {
    expect(extractErrorMessage('', '')).toBeUndefined();
    expect(extractErrorMessage('   ', '\n')).toBeUndefined();
  });
});
