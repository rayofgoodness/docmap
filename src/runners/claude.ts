import { execa } from 'execa';
import type { AgentRunner, RunnerInvocation, RunnerResult } from './types.js';

export function buildClaudeArgs(invocation: RunnerInvocation): string[] {
  const args = [
    '-p', invocation.prompt,
    '--output-format', 'json',
    '--allowedTools', (invocation.allowedTools ?? ['Read', 'Grep', 'Glob']).join(','),
  ];
  if (invocation.model) args.push('--model', invocation.model);
  if (invocation.extraArgs) args.push(...invocation.extraArgs);
  return args;
}

function extractText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.result === 'string') return parsed.result;
    if (typeof parsed?.text === 'string') return parsed.text;
  } catch {
    // stdout wasn't JSON — fall through to raw text
  }
  return stdout;
}

export const claudeRunner: AgentRunner = {
  name: 'claude',

  async checkAvailable() {
    try {
      await execa('claude', ['--version']);
      return { available: true };
    } catch (err) {
      return { available: false, reason: `"claude" CLI not found on PATH (${(err as Error).message})` };
    }
  },

  async run(invocation: RunnerInvocation): Promise<RunnerResult> {
    const start = Date.now();
    try {
      const result = await execa('claude', buildClaudeArgs(invocation), {
        cwd: invocation.cwd,
        timeout: invocation.timeoutMs,
        reject: false,
      });
      const rawOutput = result.stdout;
      return {
        ok: result.exitCode === 0,
        rawOutput,
        text: extractText(rawOutput),
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
