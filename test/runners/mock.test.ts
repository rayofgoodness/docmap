import { describe, expect, it } from 'vitest';
import { mockRunner } from '../../src/runners/mock.js';
import { parseAgentOutput } from '../../src/core/markers.js';

describe('mockRunner', () => {
  it('is always available', async () => {
    await expect(mockRunner.checkAvailable()).resolves.toEqual({ available: true });
  });

  it('emits output that parses into a body and one block per element', async () => {
    const result = await mockRunner.run({
      prompt: 'irrelevant',
      cwd: '/tmp',
      moduleId: 'mod',
      elementIds: ['a.ts', 'b.ts'],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    const parsed = parseAgentOutput(result.text);
    expect(parsed.body).not.toBeNull();
    expect(Object.keys(parsed.elements).sort()).toEqual(['a.ts', 'b.ts']);
  });
});
