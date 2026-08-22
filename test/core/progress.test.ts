import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDuration, ProgressTracker } from '../../src/core/progress.js';
import type { Logger } from '../../src/utils/logger.js';

describe('formatDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(3_725_000)).toBe('1h02m');
  });
});

describe('ProgressTracker heartbeat', () => {
  let lines: string[];
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
    logger = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      debug: () => {},
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent while nothing is running and reports active batches with elapsed time', () => {
    const tracker = new ProgressTracker(logger, 3, 1000);
    tracker.startHeartbeat();

    vi.advanceTimersByTime(1000);
    expect(lines).toEqual([]);

    tracker.batchStarted('components#1');
    vi.advanceTimersByTime(1000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('components#1 (1s)');
    expect(lines[0]).toContain('batches done: 0');
    expect(lines[0]).toContain('modules: 0/3');

    tracker.batchFinished('components#1');
    tracker.moduleFinished();
    vi.advanceTimersByTime(1000);
    expect(lines).toHaveLength(1);

    tracker.stop();
  });

  it('counts finished batches and modules in the report', () => {
    const tracker = new ProgressTracker(logger, 5, 1000);
    tracker.startHeartbeat();

    tracker.batchStarted('a#1');
    tracker.batchFinished('a#1');
    tracker.moduleFinished();
    tracker.batchStarted('b#1');
    vi.advanceTimersByTime(1000);

    expect(lines[0]).toContain('running: b#1 (1s)');
    expect(lines[0]).toContain('batches done: 1');
    expect(lines[0]).toContain('modules: 1/5');

    tracker.stop();
  });

  it('stops reporting after stop()', () => {
    const tracker = new ProgressTracker(logger, 1, 1000);
    tracker.startHeartbeat();
    tracker.batchStarted('a#1');
    tracker.stop();

    vi.advanceTimersByTime(5000);
    expect(lines).toEqual([]);
  });
});
