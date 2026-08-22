import type { Logger } from '../utils/logger.js';

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${String(sec).padStart(2, '0')}s`;
  const hours = Math.floor(min / 60);
  return `${hours}h${String(min % 60).padStart(2, '0')}m`;
}

/** Periodically reports which batches are in flight so long agent calls read as work, not a hang.
 * Purely additive: every event is also a plain log line, so CI output stays useful. */
export class ProgressTracker {
  private readonly active = new Map<string, number>();
  private batchesDone = 0;
  private modulesDone = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly modulesTotal: number,
    private readonly intervalMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  batchStarted(label: string): void {
    this.active.set(label, this.now());
  }

  batchFinished(label: string): void {
    this.active.delete(label);
    this.batchesDone += 1;
  }

  moduleFinished(): void {
    this.modulesDone += 1;
  }

  private beat(): void {
    if (this.active.size === 0) return;
    const running = [...this.active.entries()]
      .map(([label, startedAt]) => `${label} (${formatDuration(this.now() - startedAt)})`)
      .join(', ');
    this.logger.info(
      `[progress] running: ${running} · batches done: ${this.batchesDone} · modules: ${this.modulesDone}/${this.modulesTotal}`,
    );
  }
}
