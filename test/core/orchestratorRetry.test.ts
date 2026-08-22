import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBatch } from '../../src/core/orchestrator.js';
import { splitIntoBatches } from '../../src/core/promptBuilder.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { BODY_START, BODY_END, elementStartMarker, ELEMENT_END } from '../../src/core/markers.js';
import type { AgentRunner, RunnerInvocation, RunnerResult } from '../../src/runners/types.js';
import type { ElementDescriptor, ModuleDescriptor, SourceFileRef } from '../../src/adapters/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-retry-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeModule(): Promise<ModuleDescriptor> {
  const absPath = path.join(tmpDir, 'index.ts');
  await fs.writeFile(absPath, 'export const run = () => 1;');
  const stat = await fs.stat(absPath);
  const file: SourceFileRef = { absPath, relPath: 'index.ts', sizeBytes: stat.size };
  const element: ElementDescriptor = { id: 'index.ts', kind: 'file', name: 'index.ts', files: [file] };
  return {
    id: 'mod',
    name: 'mod',
    rootPath: tmpDir,
    relRootPath: 'mod',
    framework: 'generic',
    elements: [element],
    relations: [],
    files: [file],
  };
}

function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
  return { ok: true, rawOutput: '', text: '', durationMs: 50, exitCode: 0, ...overrides };
}

const successText = [
  `${BODY_START}module docs${BODY_END}`,
  `${elementStartMarker('index.ts')}element docs${ELEMENT_END}`,
].join('\n');

function fakeRunner(results: RunnerResult[]): { runner: AgentRunner; invocations: RunnerInvocation[] } {
  const invocations: RunnerInvocation[] = [];
  const queue = [...results];
  return {
    invocations,
    runner: {
      name: 'mock',
      async checkAvailable() {
        return { available: true };
      },
      async run(invocation) {
        invocations.push(invocation);
        return queue.shift() ?? results[results.length - 1]!;
      },
    },
  };
}

async function runSingleBatch(runner: AgentRunner, configOverrides: { timeoutMs: number; maxRetries: number }) {
  const module = await makeModule();
  const config = { ...getDefaultConfig(), ...configOverrides };
  const [batch] = splitIntoBatches(module, config.maxFilesPerPrompt);
  return runBatch({ module, batch: batch!, projectRoot: tmpDir, config, runner });
}

describe('runBatch retry behavior', () => {
  it('doubles the timeout and reuses the plain prompt when the first attempt likely timed out', async () => {
    const { runner, invocations } = fakeRunner([
      runnerResult({ ok: false, durationMs: 1000, exitCode: null }),
      runnerResult({ text: successText }),
    ]);

    const outcome = await runSingleBatch(runner, { timeoutMs: 1000, maxRetries: 1 });

    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.timeoutMs).toBe(1000);
    expect(invocations[1]!.timeoutMs).toBe(2000);
    expect(invocations[1]!.prompt).toBe(invocations[0]!.prompt);
    expect(outcome.effectiveTimeoutMs).toBe(2000);
    expect(outcome.parsed.body).toBe('module docs');
    expect(outcome.parsed.elements['index.ts']).toBe('element docs');
  });

  it('keeps the timeout and appends the stricter contract reminder when the agent replied without markers', async () => {
    const { runner, invocations } = fakeRunner([
      runnerResult({ text: 'chatty response without any markers' }),
      runnerResult({ text: successText }),
    ]);

    const outcome = await runSingleBatch(runner, { timeoutMs: 1000, maxRetries: 1 });

    expect(invocations).toHaveLength(2);
    expect(invocations[1]!.timeoutMs).toBe(1000);
    expect(invocations[1]!.prompt).toContain('did not include the required marker');
    expect(outcome.effectiveTimeoutMs).toBe(1000);
    expect(outcome.parsed.body).toBe('module docs');
  });

  it('resends the unmodified prompt at the same timeout when the runner itself failed fast (not a timeout)', async () => {
    const { runner, invocations } = fakeRunner([
      runnerResult({ ok: false, durationMs: 50, exitCode: 1, error: "model not found" }),
      runnerResult({ text: successText }),
    ]);

    const outcome = await runSingleBatch(runner, { timeoutMs: 1000, maxRetries: 1 });

    expect(invocations).toHaveLength(2);
    expect(invocations[1]!.timeoutMs).toBe(1000);
    expect(invocations[1]!.prompt).toBe(invocations[0]!.prompt);
    expect(invocations[1]!.prompt).not.toContain('did not include the required marker');
    expect(outcome.parsed.body).toBe('module docs');
  });

  it('reports the escalated timeout after exhausting retries on repeated timeouts', async () => {
    const { runner, invocations } = fakeRunner([
      runnerResult({ ok: false, durationMs: 1000, exitCode: null }),
      runnerResult({ ok: false, durationMs: 2000, exitCode: null }),
    ]);

    const outcome = await runSingleBatch(runner, { timeoutMs: 1000, maxRetries: 1 });

    expect(invocations).toHaveLength(2);
    expect(outcome.effectiveTimeoutMs).toBe(2000);
    expect(outcome.parsed.body).toBeNull();
  });

  it('does not retry at all when maxRetries is 0', async () => {
    const { runner, invocations } = fakeRunner([runnerResult({ ok: false, durationMs: 1000, exitCode: null })]);

    const outcome = await runSingleBatch(runner, { timeoutMs: 1000, maxRetries: 0 });

    expect(invocations).toHaveLength(1);
    expect(outcome.effectiveTimeoutMs).toBe(1000);
  });
});
