import type { RunnerName } from '../types.js';
import type { AgentRunner } from './types.js';
import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import { geminiRunner } from './gemini.js';
import { mockRunner } from './mock.js';

const RUNNERS: Record<RunnerName, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
  gemini: geminiRunner,
  mock: mockRunner,
};

export function getRunner(name: RunnerName): AgentRunner {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`Unknown runner: "${name}"`);
  return runner;
}
