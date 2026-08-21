import { describe, expect, it } from 'vitest';
import { describeBatchFailure } from '../../src/core/orchestrator.js';
import type { RunnerResult } from '../../src/runners/types.js';

function result(overrides: Partial<RunnerResult>): RunnerResult {
  return { ok: true, rawOutput: '', text: '', durationMs: 1000, exitCode: 0, ...overrides };
}

describe('describeBatchFailure', () => {
  it('flags a likely timeout when duration is close to the configured limit', () => {
    const reason = describeBatchFailure(result({ ok: false, durationMs: 119_500, exitCode: null }), 120_000);
    expect(reason).toContain('timed out');
  });

  it('reports the exit code and stderr when the runner failed well before the timeout', () => {
    const reason = describeBatchFailure(
      result({ ok: false, durationMs: 500, exitCode: 1, error: 'usage limit reached' }),
      120_000,
    );
    expect(reason).toContain('exited 1');
    expect(reason).toContain('usage limit reached');
  });

  it('reports a marker-format miss when the runner call itself succeeded', () => {
    const reason = describeBatchFailure(result({ ok: true, exitCode: 0 }), 120_000);
    expect(reason).toContain('without the required marker');
  });
});
