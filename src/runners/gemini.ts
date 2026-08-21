import { execa } from 'execa';
import type { AgentRunner, RunnerInvocation, RunnerResult } from './types.js';

export function buildGeminiArgs(invocation: RunnerInvocation): string[] {
  const args = ['-p', invocation.prompt];
  if (invocation.model) args.push('--model', invocation.model);
  if (invocation.extraArgs) args.push(...invocation.extraArgs);
  return args;
}

export const geminiRunner: AgentRunner = {
  name: 'gemini',

  async checkAvailable() {
    try {
      await execa('gemini', ['--version']);
      return { available: true };
    } catch (err) {
      return { available: false, reason: `"gemini" CLI not found on PATH (${(err as Error).message})` };
    }
  },

  async run(invocation: RunnerInvocation): Promise<RunnerResult> {
    const start = Date.now();
    try {
      const result = await execa('gemini', buildGeminiArgs(invocation), {
        cwd: invocation.cwd,
        timeout: invocation.timeoutMs,
        reject: false,
      });
      const rawOutput = result.stdout;
      return {
        ok: result.exitCode === 0,
        rawOutput,
        text: rawOutput,
        durationMs: Date.now() - start,
        exitCode: result.exitCode ?? null,
        error: result.exitCode === 0 ? undefined : result.stderr,
      };
    } catch (err) {
      return {
        ok: false,
        rawOutput: '',
        text: '',
        durationMs: Date.now() - start,
        exitCode: null,
        error: (err as Error).message,
      };
    }
  },
};
