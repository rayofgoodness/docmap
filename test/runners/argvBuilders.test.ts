import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../src/runners/claude.js';
import { buildCodexArgs } from '../../src/runners/codex.js';
import { buildGeminiArgs } from '../../src/runners/gemini.js';
import type { RunnerInvocation } from '../../src/runners/types.js';

function baseInvocation(overrides: Partial<RunnerInvocation> = {}): RunnerInvocation {
  return {
    prompt: 'document this module',
    cwd: '/project',
    moduleId: 'mod',
    elementIds: [],
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('runner argv builders (pure, no subprocess)', () => {
  it('claude: includes read-only allowedTools and json output by default', () => {
    const args = buildClaudeArgs(baseInvocation());
    expect(args).toEqual([
      '-p', 'document this module',
      '--output-format', 'json',
      '--allowedTools', 'Read,Grep,Glob',
    ]);
  });

  it('claude: appends --model when set', () => {
    const args = buildClaudeArgs(baseInvocation({ model: 'claude-sonnet-5' }));
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-5');
  });

  it('codex: uses read-only sandbox and passes cwd', () => {
    const args = buildCodexArgs(baseInvocation());
    expect(args).toEqual(['exec', 'document this module', '--sandbox', 'read-only', '--cd', '/project', '--json']);
  });

  it('gemini: passes prompt via -p', () => {
    const args = buildGeminiArgs(baseInvocation());
    expect(args).toEqual(['-p', 'document this module']);
  });
});
