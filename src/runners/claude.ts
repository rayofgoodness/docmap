import { execa } from 'execa';
import type { AgentRunner, RunnerInvocation, RunnerResult } from './types.js';

export function buildClaudeArgs(invocation: RunnerInvocation): string[] {
  const args = [
    '-p', invocation.prompt,
    '--output-format', 'json',
    '--allowedTools', (invocation.allowedTools ?? ['Read', 'Grep', 'Glob']).join(','),
    // No --mcp-config is passed, so this disables MCP entirely: doc batches only need
    // Read/Grep/Glob, and spawning the user's MCP servers on every batch adds startup cost.
    '--strict-mcp-config',
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

/** The claude CLI prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN over
 * the user's claude.ai login when any is present. A stale/invalid credential in the shell profile
 * then fails every batch with exit 1 even though `claude` works interactively. When the CLI itself
 * reports that conflict, retry once with those variables stripped so the login session is used;
 * environments that genuinely auth via a valid key never hit this path (they don't exit non-zero). */
const AUTH_CONFLICT_MARKER = 'auth source is set';
const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

async function execClaude(invocation: RunnerInvocation, env?: Record<string, string | undefined>) {
  return execa('claude', buildClaudeArgs(invocation), {
    cwd: invocation.cwd,
    timeout: invocation.timeoutMs,
    reject: false,
    stdin: 'ignore',
    ...(env ? { env, extendEnv: false } : {}),
  });
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
      let result = await execClaude(invocation);
      if (
        result.exitCode !== 0 &&
        AUTH_ENV_VARS.some((v) => process.env[v]) &&
        `${result.stderr}\n${result.stdout}`.includes(AUTH_CONFLICT_MARKER)
      ) {
        const cleanEnv: Record<string, string | undefined> = { ...process.env };
        for (const v of AUTH_ENV_VARS) delete cleanEnv[v];
        result = await execClaude(invocation, cleanEnv);
      }
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
