import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSinceContext,
  runVerify,
  verifyModule,
  type VerifyModuleReport,
} from '../../src/core/verify.js';
import { genericAdapter } from '../../src/adapters/generic/index.js';
import { writeModuleDoc } from '../../src/core/docWriter.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { createLogger } from '../../src/utils/logger.js';
import type { ModuleFrontmatter } from '../../src/docFormat/frontmatter.js';
import type { AgentRunner, RunnerInvocation, RunnerResult } from '../../src/runners/types.js';
import type { DiscoveryContext, ModuleDescriptor } from '../../src/adapters/types.js';

let tmpDir: string;
const logger = createLogger();

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-verify-since-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd });
  return result.stdout;
}

async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'docmap-test@example.com']);
  await git(dir, ['config', 'user.name', 'Docmap Test']);
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

function makeFrontmatter(overrides: Partial<ModuleFrontmatter>): ModuleFrontmatter {
  return {
    docmap_version: 1,
    kind: 'module',
    id: 'orders',
    name: 'orders',
    framework: 'generic',
    path: 'orders',
    status: 'implemented',
    language: 'en',
    fingerprint: 'sha256:stale-marker',
    generated_at: '2026-01-01T00:00:00.000Z',
    generated_by: { runner: 'mock' },
    elements: [],
    invariants: [{ id: 'I1', text: 'An order can only be cancelled while pending or on-hold.' }],
    dependencies: [],
    dependents: [],
    tags: [],
    ...overrides,
  };
}

function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
  return { ok: true, rawOutput: '', text: '', durationMs: 50, exitCode: 0, ...overrides };
}

const compatibleVerifyText = [
  '<<<DOCMAP_VERIFY_START>>>',
  '## Summary',
  'COMPATIBLE',
  '## Invariants',
  'I1: KEPT — still gated on status.',
  '## Undocumented',
  '(none)',
  '<<<DOCMAP_VERIFY_END>>>',
].join('\n');

function capturingRunner(text = compatibleVerifyText): { runner: AgentRunner; invocations: RunnerInvocation[] } {
  const invocations: RunnerInvocation[] = [];
  return {
    invocations,
    runner: {
      name: 'mock',
      async checkAvailable() {
        return { available: true };
      },
      async run(invocation) {
        invocations.push(invocation);
        return runnerResult({ text });
      },
    },
  };
}

/** Sets up a repo with two modules ("orders", "cart") and two commits: a baseline, then a change that
 * only touches orders/index.ts. Returns the base commit ref (the `--since` argument under test) plus
 * both discovered modules. */
async function setupTwoModuleRepo(): Promise<{
  baseRef: string;
  orders: ModuleDescriptor;
  cart: ModuleDescriptor;
}> {
  await initGitRepo(tmpDir);

  await fs.mkdir(path.join(tmpDir, 'orders'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'orders', 'index.ts'),
    'export function cancelOrder(order) { return order.status === "pending"; }\n',
  );
  await fs.mkdir(path.join(tmpDir, 'cart'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'cart', 'index.ts'), 'export function addToCart(item) { return true; }\n');

  const baseRef = await commitAll(tmpDir, 'baseline');

  // Regression: cancellation is no longer gated on status. cart/ is left untouched.
  await fs.writeFile(path.join(tmpDir, 'orders', 'index.ts'), 'export function cancelOrder(order) { return true; }\n');
  await commitAll(tmpDir, 'drop status guard');

  const ctx: DiscoveryContext = { projectRoot: tmpDir, config: getDefaultConfig(), logger };
  const modules = await genericAdapter.discoverModules(ctx);
  const orders = modules.find((m) => m.name === 'orders');
  const cart = modules.find((m) => m.name === 'cart');
  if (!orders || !cart) throw new Error('fixture modules not discovered');
  return { baseRef, orders, cart };
}

describe('resolveSinceContext', () => {
  it('resolves changed files relative to the project root for a valid ref', async () => {
    const { baseRef } = await setupTwoModuleRepo();

    const since = await resolveSinceContext(baseRef, tmpDir, logger);

    expect(since).not.toBeNull();
    expect(since?.changedFiles).toContain('orders/index.ts');
    expect(since?.changedFiles).not.toContain('cart/index.ts');
  });

  it('returns null and logs a warning when the ref does not exist', async () => {
    await setupTwoModuleRepo();
    const warnSpy = vi.spyOn(logger, 'warn');

    const since = await resolveSinceContext('not-a-real-ref-xyz', tmpDir, logger);

    expect(since).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/--since ignored:[\s\S]*falling back to full-module verification/));
  });

  it('resolves changed files relative to projectRoot (not the repo top-level) when projectRoot is a subdirectory of a larger git repo', async () => {
    // Monorepo shape: the git repo root is tmpDir, but docmap's projectRoot is a package subdirectory
    // of it. Without `--relative`, git's own output is repo-root-relative (e.g.
    // "packages/pkg-a/orders/index.ts"), which never intersects a module's projectRoot-relative files
    // (e.g. "orders/index.ts"), so `--since` silently no-ops for every module.
    await initGitRepo(tmpDir);
    const projectRoot = path.join(tmpDir, 'packages', 'pkg-a');
    await fs.mkdir(path.join(projectRoot, 'orders'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'orders', 'index.ts'),
      'export function cancelOrder(order) { return order.status === "pending"; }\n',
    );
    const baseRef = await commitAll(tmpDir, 'baseline');

    await fs.writeFile(
      path.join(projectRoot, 'orders', 'index.ts'),
      'export function cancelOrder(order) { return true; }\n',
    );
    await commitAll(tmpDir, 'drop status guard');

    const since = await resolveSinceContext(baseRef, projectRoot, logger);

    expect(since).not.toBeNull();
    // projectRoot-relative, as resolveSinceDiffForModule assumes — never the repo-root-relative
    // "packages/pkg-a/orders/index.ts".
    expect(since?.changedFiles).toContain('orders/index.ts');
    expect(since?.changedFiles).not.toContain('packages/pkg-a/orders/index.ts');
  });

  it('returns null and logs a warning when the directory is not a git repository at all', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-not-a-repo-'));
    try {
      const warnSpy = vi.spyOn(logger, 'warn');
      const since = await resolveSinceContext('HEAD~1', nonGitDir, logger);

      expect(since).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/--since ignored:/));
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe('verifyModule with --since', () => {
  it('injects the unified diff into the prompt for a module whose files changed since the ref', async () => {
    const { baseRef, orders } = await setupTwoModuleRepo();
    await writeModuleDoc(tmpDir, orders, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');

    const since = await resolveSinceContext(baseRef, tmpDir, logger);
    expect(since).not.toBeNull();

    const { runner, invocations } = capturingRunner();
    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 };
    const report = await verifyModule({ module: orders, projectRoot: tmpDir, config, logger, runner, since: since! });

    expect(invocations).toHaveLength(1);
    const prompt = invocations[0]!.prompt;
    expect(prompt).toContain(`The following file(s) changed since ${baseRef} — pay particular attention to this diff when judging each invariant`);
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('-export function cancelOrder(order) { return order.status === "pending"; }');
    expect(prompt).toContain('+export function cancelOrder(order) { return true; }');
    // The full current-source excerpt must still be present alongside the diff, not replaced by it.
    expect(prompt).toContain('=== CURRENT SOURCE ===');
    expect(prompt).toContain('cancelOrder');
    expect((report as VerifyModuleReport).status).toBe('verified');
  });

  it('does not inject diff text for a module whose files were not touched by the diff', async () => {
    const { baseRef, cart } = await setupTwoModuleRepo();
    await writeModuleDoc(
      tmpDir,
      cart,
      makeFrontmatter({ id: 'cart', name: 'cart', path: 'cart', fingerprint: 'sha256:stale-marker' }),
      '## Business Logic\nCart.',
    );

    const since = await resolveSinceContext(baseRef, tmpDir, logger);
    expect(since).not.toBeNull();

    const { runner, invocations } = capturingRunner();
    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 };
    await verifyModule({ module: cart, projectRoot: tmpDir, config, logger, runner, since: since! });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.prompt).not.toContain('pay particular attention to this diff');
    expect(invocations[0]!.prompt).not.toContain('```diff');
  });

  it('runs in full-module mode without throwing when since is undefined (ref/repo unavailable upstream)', async () => {
    const { orders } = await setupTwoModuleRepo();
    await writeModuleDoc(tmpDir, orders, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');

    const { runner, invocations } = capturingRunner();
    const config = { ...getDefaultConfig(), maxRetries: 1, timeoutMs: 1000 };
    const report = await verifyModule({ module: orders, projectRoot: tmpDir, config, logger, runner, since: undefined });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.prompt).not.toContain('pay particular attention to this diff');
    expect(report.status).toBe('verified');
    expect(report.error).toBeUndefined();
  });
});

describe('runVerify with --since', () => {
  it('falls back to full-module verification without throwing when the ref does not exist', async () => {
    const { orders } = await setupTwoModuleRepo();
    await writeModuleDoc(tmpDir, orders, makeFrontmatter({ fingerprint: 'sha256:stale-marker' }), '## Business Logic\nOrders.');
    const warnSpy = vi.spyOn(logger, 'warn');

    const config = { ...getDefaultConfig(), maxRetries: 0, timeoutMs: 1000 };
    await expect(
      runVerify({ projectRoot: tmpDir, config, logger, runnerName: 'mock', sinceRef: 'nonexistent-ref' }),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/--since ignored:[\s\S]*falling back to full-module verification/));
  });

  it('falls back to full-module verification without throwing when projectRoot is not a git repository', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmap-not-a-repo-run-'));
    try {
      await fs.mkdir(path.join(nonGitDir, 'orders'), { recursive: true });
      await fs.writeFile(path.join(nonGitDir, 'orders', 'index.ts'), 'export const x = 1;\n');
      const warnSpy = vi.spyOn(logger, 'warn');

      const config = { ...getDefaultConfig(), maxRetries: 0, timeoutMs: 1000 };
      const summary = await runVerify({
        projectRoot: nonGitDir,
        config,
        logger,
        runnerName: 'mock',
        sinceRef: 'HEAD~1',
      });

      expect(summary.reports.length).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/--since ignored:/));
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });
});
