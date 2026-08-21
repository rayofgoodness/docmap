import type { RunnerName } from '../types.js';

export interface RunnerInvocation {
  prompt: string;
  cwd: string;
  moduleId: string;
  elementIds: string[];
  timeoutMs: number;
  model?: string;
  allowedTools?: string[];
  extraArgs?: string[];
}

export interface RunnerResult {
  ok: boolean;
  rawOutput: string;
  text: string;
  durationMs: number;
  exitCode: number | null;
  error?: string;
}

export interface AgentRunner {
  name: RunnerName;
  checkAvailable(): Promise<{ available: boolean; reason?: string }>;
  run(invocation: RunnerInvocation): Promise<RunnerResult>;
}
