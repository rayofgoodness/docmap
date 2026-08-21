import { BODY_END, BODY_START, ELEMENT_END, elementStartMarker } from '../core/markers.js';
import type { AgentRunner, RunnerInvocation, RunnerResult } from './types.js';

function buildMockOutput(invocation: RunnerInvocation): string {
  const parts = [
    BODY_START,
    `## Purpose`,
    `Mock-generated overview for module "${invocation.moduleId}".`,
    BODY_END,
  ];

  for (const elementId of invocation.elementIds) {
    parts.push(elementStartMarker(elementId), `Mock-generated summary for element "${elementId}".`, ELEMENT_END);
  }

  return parts.join('\n');
}

export const mockRunner: AgentRunner = {
  name: 'mock',

  async checkAvailable() {
    return { available: true };
  },

  async run(invocation: RunnerInvocation): Promise<RunnerResult> {
    const start = Date.now();
    const rawOutput = buildMockOutput(invocation);
    return {
      ok: true,
      rawOutput,
      text: rawOutput,
      durationMs: Date.now() - start,
      exitCode: 0,
    };
  },
};
