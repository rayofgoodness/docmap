import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import type { BriefFrontmatter, ModuleFrontmatter } from '../docFormat/frontmatter.js';
import type { RunnerName } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { getSectionLabels, type SectionLabels } from '../utils/lang.js';
import { discoverProject } from './discovery.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { formatDuration, ProgressTracker } from './progress.js';
import { getRunner } from '../runners/registry.js';
import { readBriefDoc, readModuleDoc, writeBriefDoc } from './docWriter.js';
import { describeBatchFailure, isLikelyTimeout } from './orchestrator.js';
import type { AgentRunner, RunnerResult } from '../runners/types.js';

/**
 * Marker vocabulary for `docmap brief`. Deliberately distinct from markers.ts's generate markers and
 * verify.ts's VERIFY_START/END — a brief response is a single business-facing block derived from an
 * already-generated tech doc, never source, and must never be confused with either of the other two
 * response shapes by a parser or by a human grepping raw agent output.
 */
export const BRIEF_START = '<<<DOCMAP_BRIEF_START>>>';
export const BRIEF_END = '<<<DOCMAP_BRIEF_END>>>';

/**
 * Extracts the content between BRIEF_START/BRIEF_END — same simple single-block extraction style as
 * markers.ts's BODY_START/BODY_END (not the more complex per-element pattern), since a brief is always
 * exactly one block. Returns null when the markers aren't both present, which is the signal
 * runBriefCall uses to trigger a stricter-prompt retry.
 */
export function parseBriefOutput(text: string): string | null {
  const startIdx = text.indexOf(BRIEF_START);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(BRIEF_END, startIdx + BRIEF_START.length);
  if (endIdx === -1) return null;
  return text.slice(startIdx + BRIEF_START.length, endIdx).trim();
}

/**
 * Builds the brief prompt. The input is explicitly the READY TECH DOC (`techDoc.body` — the
 * already-generated module README content, including its Business Logic and Invariants sections), NOT
 * raw source — this keeps brief cheap and guarantees the business doc can never contradict the tech
 * doc, since it IS derived from it (single source of truth).
 */
export function buildBriefPrompt(
  module: ModuleDescriptor,
  techDoc: { frontmatter: ModuleFrontmatter; body: string },
  labels: SectionLabels,
  language: string,
): string {
  const invariants = techDoc.frontmatter.invariants ?? [];
  const hasInvariants = invariants.length > 0;
  const invariantsList = hasInvariants
    ? invariants.map((inv) => `${inv.id}: ${inv.text}`).join('\n')
    : '(none documented)';

  const dependents = (module.metadata?.dependents as Array<{ module: string; type: string }> | undefined) ?? [];
  const dependencyNote =
    dependents.length > 0
      ? `Other modules that currently depend on this one (from the relation graph): ${dependents
          .map((d) => `${d.module} (${d.type})`)
          .join(', ')}.`
      : 'No other modules currently depend on this one, per the relation graph.';

  const lines: string[] = [
    `You are writing a BUSINESS BRIEF of the "${module.name}" module for a manager or QA person — not a developer. Your input is the module's EXISTING, ALREADY-GENERATED technical documentation below, not raw source code. Never contradict it and never invent behavior it does not describe: the brief must be a faithful, plain-language retelling of the tech doc, so the business doc can never drift from the tech doc it is derived from.`,
    `Write ALL prose in language code "${language}". Keep the "I1:", "I2:", ... invariant id prefixes in "## ${labels.briefBusinessRules}" and "## ${labels.briefWhatToCheck}" literal and untranslated — they exist for traceability back to the tech doc's invariants.`,
    '',
    '=== TECH DOC (source of truth) ===',
    techDoc.body,
    '',
  ];

  if (hasInvariants) {
    lines.push(
      'The tech doc declares exactly these invariants (use these exact ids, and cover every single one — no more, no fewer):',
      invariantsList,
    );
  } else {
    lines.push(
      `The tech doc declares no invariants (it predates invariant tracking, or the module genuinely has none documented). Write "(none documented)" for both "## ${labels.briefBusinessRules}" and "## ${labels.briefWhatToCheck}" below, and produce the rest of the brief as a best-effort plain-language summary from the Business Logic prose alone.`,
    );
  }

  lines.push('', dependencyNote);

  const businessRulesContract = hasInvariants
    ? invariants.map((inv) => `${inv.id}: <the invariant retold in plain, non-technical language>`).join('\n')
    : '(none documented)';
  const whatToCheckContract = hasInvariants
    ? invariants.map((inv) => `${inv.id}: <a concrete, imperative QA step testing exactly that rule>`).join('\n')
    : '(none documented)';

  lines.push(
    '',
    'Output contract — respond with ONLY the following block, no other prose:',
    BRIEF_START,
    `## ${labels.briefWhatItDoes}`,
    '(3-5 plain-language sentences, no jargon)',
    '',
    `## ${labels.briefKeyScenarios}`,
    '- <user-facing flow this module supports>',
    '- ...',
    '',
    `## ${labels.briefBusinessRules}`,
    businessRulesContract,
    '(one line per invariant id listed above — every id must appear here)',
    '',
    `## ${labels.briefWhatToCheck}`,
    whatToCheckContract,
    '(same id set as above, one concrete imperative check per id, e.g. "Create an order, set it to pending, cancel it, confirm it moves to cancelled")',
    '',
    `## ${labels.briefDependencyRisks}`,
    '- <module/relation-derived list of what else changes here affect, or "(no other modules currently depend on this one)">',
    BRIEF_END,
  );

  return lines.join('\n');
}

export interface BriefCallOutcome {
  parsed: string | null;
  lastResult: RunnerResult;
}

/**
 * Single brief call with the same retry-escalation shape as verify.ts's runVerifyCall: timeout doubling
 * on a likely timeout, a plain resend on a runner error, and a stricter-contract-reminder resend when
 * the agent replied without the required marker block.
 */
export async function runBriefCall(
  module: ModuleDescriptor,
  techDoc: { frontmatter: ModuleFrontmatter; body: string },
  projectRoot: string,
  config: ResolvedDocmapConfig,
  runner: AgentRunner,
  logger?: Logger,
): Promise<BriefCallOutcome> {
  const labels = getSectionLabels(config.language);
  const prompt = buildBriefPrompt(module, techDoc, labels, config.language);

  const call = async (p: string, timeoutMs: number) => {
    const result = await runner.run({
      prompt: p,
      cwd: projectRoot,
      moduleId: module.id,
      elementIds: [],
      timeoutMs,
      model: config.model,
    });
    return { result, parsed: parseBriefOutput(result.text) };
  };

  let timeoutMs = config.timeoutMs;
  let { result, parsed } = await call(prompt, timeoutMs);

  let attempts = 0;
  while (parsed === null && attempts < config.maxRetries) {
    attempts += 1;
    if (isLikelyTimeout(result, timeoutMs)) {
      timeoutMs *= 2;
      logger?.info(
        `[retry] ${module.id} — brief attempt ${attempts + 1}/${config.maxRetries + 1} with timeout raised to ${Math.round(timeoutMs / 1000)}s`,
      );
      ({ result, parsed } = await call(prompt, timeoutMs));
    } else if (!result.ok) {
      logger?.info(
        `[retry] ${module.id} — brief attempt ${attempts + 1}/${config.maxRetries + 1} after a runner error: ${describeBatchFailure(result, timeoutMs)}`,
      );
      ({ result, parsed } = await call(prompt, timeoutMs));
    } else {
      const stricterPrompt = `${prompt}\n\nIMPORTANT: your previous response did not follow the required output contract (a ${BRIEF_START}...${BRIEF_END} block). Respond again, following the output contract exactly.`;
      logger?.info(
        `[retry] ${module.id} — brief attempt ${attempts + 1}/${config.maxRetries + 1} after a contract-format miss`,
      );
      ({ result, parsed } = await call(stricterPrompt, timeoutMs));
    }
  }

  return { parsed, lastResult: result };
}

export type BriefModuleStatus = 'missing' | 'unchanged' | 'generated' | 'error';

export interface BriefModuleReport {
  moduleId: string;
  name: string;
  status: BriefModuleStatus;
  error?: string;
}

export interface BriefOptions {
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runnerName: RunnerName;
  moduleIds?: string[];
}

export interface BriefSummary {
  frameworkName: string;
  reports: BriefModuleReport[];
}

export async function runBrief(options: BriefOptions): Promise<BriefSummary> {
  const { projectRoot, config, logger, runnerName } = options;

  const ctx: DiscoveryContext = { projectRoot, config, logger };
  const { frameworkName, modules } = await discoverProject(ctx);
  const targetModules = options.moduleIds?.length
    ? modules.filter((m) => options.moduleIds!.includes(m.id))
    : modules;

  if (options.moduleIds?.length) {
    const matchedIds = new Set(targetModules.map((m) => m.id));
    const unknownIds = options.moduleIds.filter((id) => !matchedIds.has(id));
    if (unknownIds.length > 0) {
      const available = modules.map((m) => m.id).join(', ') || '(no modules discovered)';
      throw new Error(
        `Unknown module id${unknownIds.length > 1 ? 's' : ''}: ${unknownIds.map((id) => `"${id}"`).join(', ')}. Available modules: ${available}`,
      );
    }
  }

  const runner = getRunner(runnerName);
  const availability = await runner.checkAvailable();
  if (!availability.available) {
    throw new Error(`Runner "${runnerName}" is unavailable: ${availability.reason}`);
  }

  const limit = createConcurrencyLimiter(config.concurrency);
  const reports: BriefModuleReport[] = [];

  const progress = new ProgressTracker(logger, targetModules.length);
  logger.info(
    `[brief] ${targetModules.length} modules · runner=${runnerName} concurrency=${config.concurrency} timeout=${Math.round(config.timeoutMs / 1000)}s`,
  );
  progress.startHeartbeat();

  try {
    await Promise.all(
      targetModules.map((module) =>
        limit(async () => {
          try {
            const report = await briefModule({ module, projectRoot, config, logger, runner, progress });
            reports.push(report);
          } catch (err) {
            reports.push({ moduleId: module.id, name: module.name, status: 'error', error: (err as Error).message });
          } finally {
            progress.moduleFinished();
          }
        }),
      ),
    );
  } finally {
    progress.stop();
  }

  return { frameworkName, reports };
}

export async function briefModule(args: {
  module: ModuleDescriptor;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runner: AgentRunner;
  progress?: ProgressTracker;
}): Promise<BriefModuleReport> {
  const { module, projectRoot, config, logger, runner, progress } = args;

  const techDoc = await readModuleDoc(projectRoot, module);
  if (!techDoc) {
    logger.info(`[skip] ${module.id} — no tech doc yet, can't brief a module without one`);
    return { moduleId: module.id, name: module.name, status: 'missing' };
  }

  const techFingerprint = techDoc.frontmatter.fingerprint ?? null;
  const existingBrief = await readBriefDoc(projectRoot, module);
  if (existingBrief && existingBrief.frontmatter.source_fingerprint === techFingerprint) {
    logger.info(`[skip] ${module.id} — brief unchanged since last tech doc`);
    return { moduleId: module.id, name: module.name, status: 'unchanged' };
  }

  const label = module.id;
  logger.info(`[run] ${module.id} — briefing from tech doc`);
  progress?.batchStarted(label);
  const startedAt = Date.now();
  let outcome: BriefCallOutcome;
  try {
    outcome = await runBriefCall(module, techDoc, projectRoot, config, runner, logger);
  } finally {
    progress?.batchFinished(label);
  }

  const { parsed, lastResult } = outcome;
  if (parsed === null) {
    // A parse failure must never write a brief with garbage/missing content — surface it as an error.
    const reason = describeBatchFailure(lastResult, config.timeoutMs);
    logger.warn(`[error] ${module.id} — brief did not return a valid response (${reason})`);
    return { moduleId: module.id, name: module.name, status: 'error', error: reason };
  }

  const briefFrontmatter: BriefFrontmatter = {
    docmap_version: 1,
    kind: 'brief',
    module: module.id,
    language: config.language,
    source_fingerprint: techFingerprint,
    generated_at: new Date().toISOString(),
    generated_by: { runner: runner.name, model: config.model },
  };

  await writeBriefDoc(projectRoot, module, briefFrontmatter, parsed);
  logger.info(`[ok] ${module.id} — brief generated in ${formatDuration(Date.now() - startedAt)}`);
  return { moduleId: module.id, name: module.name, status: 'generated' };
}
