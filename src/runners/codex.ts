import { execa } from 'execa';
import type { AgentRunner, RunnerInvocation, RunnerResult } from './types.js';

export function buildCodexArgs(invocation: RunnerInvocation): string[] {
  const args = ['exec', invocation.prompt, '--sandbox', 'read-only', '--cd', invocation.cwd, '--json'];
  if (invocation.model) args.push('--model', invocation.model);
  if (invocation.extraArgs) args.push(...invocation.extraArgs);
  return args;
}

function extractText(stdout: string): string {
  // codex --json emits one JSON event per line; concatenate any text/message fields.
  const lines = stdout.split('\n').filter(Boolean);
  const chunks: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (typeof event?.text === 'string') chunks.push(event.text);
      else if (typeof event?.message === 'string') chunks.push(event.message);
    } catch {
      chunks.push(line);
    }
  }
  return chunks.length > 0 ? chunks.join('') : stdout;
}

export const codexRunner: AgentRunner = {
  name: 'codex',

  async checkAvailable() {
    try {
      await execa('codex', ['--version']);
      return { available: true };
    } catch (err) {
      return { available: false, reason: `"codex" CLI not found on PATH (${(err as Error).message})` };
    }
  },

  async run(invocation: RunnerInvocation): Promise<RunnerResult> {
    const start = Date.now();
    try {
      const result = await execa('codex', buildCodexArgs(invocation), {
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
