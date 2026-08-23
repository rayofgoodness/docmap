import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import type { ModuleFrontmatter } from '../docFormat/frontmatter.js';
import type { RunnerName } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { loadSkillInstructions } from '../utils/skillInstructions.js';
import { discoverProject } from './discovery.js';
import { computeModuleFingerprint } from './fingerprint.js';
import { collectFiles, readExcerpt } from './promptBuilder.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { formatDuration, ProgressTracker } from './progress.js';
import { getRunner } from '../runners/registry.js';
import { getDocmapRoot, readModuleDoc } from './docWriter.js';
import { describeBatchFailure, isLikelyTimeout } from './orchestrator.js';
import type { AgentRunner, RunnerResult } from '../runners/types.js';

/**
 * Marker vocabulary for `docmap verify`. Deliberately distinct from markers.ts's generate markers —
 * a verify response has a different shape (per-invariant verdicts, not per-element docs) and must never
 * be confused with a generate response by a parser or by a human grepping raw agent output.
 */
export const VERIFY_START = '<<<DOCMAP_VERIFY_START>>>';
export const VERIFY_END = '<<<DOCMAP_VERIFY_END>>>';

const KNOWN_SUMMARIES = new Set(['COMPATIBLE', 'CHANGED', 'BREAKING']);
const KNOWN_VERDICTS = new Set(['KEPT', 'CHANGED', 'VIOLATED']);

export interface InvariantVerdict {
  id: string;
  verdict: 'KEPT' | 'CHANGED' | 'VIOLATED';
  note: string;
}

export interface ParsedVerifyOutput {
  summary: 'COMPATIBLE' | 'CHANGED' | 'BREAKING' | null;
  invariants: InvariantVerdict[];
  undocumented: string[];
}

// e.g. "I1: KEPT — the guard clause still checks status" — the id/verdict separator is always ":",
// but the verdict/justification separator varies across models/temperature (em-dash, hyphen, colon).
const INVARIANT_LINE = /^(I\d+):\s*(KEPT|CHANGED|VIOLATED)\s*(?:—|-|:)\s*(.+)$/;

function extractBlock(text: string): string | null {
  const startIdx = text.indexOf(VERIFY_START);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(VERIFY_END, startIdx + VERIFY_START.length);
  if (endIdx === -1) return null;
  return text.slice(startIdx + VERIFY_START.length, endIdx);
}

/** Extracts the text directly beneath a "## <heading>" line, up to the next "## " heading or the end
 * of the block — same "marker/heading block, no JSON parsing" approach as parseInvariantsSection. */
function extractSection(block: string, heading: string): string | null {
  const lines = block.split('\n');
  const target = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === target);
  if (startIndex === -1) return null;

  const collected: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('## ')) break;
    collected.push(line);
  }
  return collected.join('\n').trim();
}

/**
 * Parses a `docmap verify` agent response. Returns null when the response doesn't follow the contract
 * at all — no VERIFY_START/END block, or a "## Summary" value that isn't one of the three known
 * words — which is exactly the signal runVerifyCall uses to trigger a stricter-prompt retry, the same
 * way parseAgentOutput's null body triggers a retry in generate.
 */
export function parseVerifyOutput(text: string): ParsedVerifyOutput | null {
  const block = extractBlock(text);
  if (block === null) return null;

  const summarySection = extractSection(block, 'Summary') ?? '';
  const summaryLine = summarySection
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!summaryLine || !KNOWN_SUMMARIES.has(summaryLine)) return null;
  const summary = summaryLine as ParsedVerifyOutput['summary'];

  const invariantsSection = extractSection(block, 'Invariants') ?? '';
  const invariants: InvariantVerdict[] = [];
  for (const rawLine of invariantsSection.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^\(none/i.test(line)) continue;
    const match = INVARIANT_LINE.exec(line);
    if (match && KNOWN_VERDICTS.has(match[2]!)) {
      invariants.push({
        id: match[1]!,
        verdict: match[2] as InvariantVerdict['verdict'],
        note: match[3]!.trim(),
      });
    }
  }

  const undocumentedSection = extractSection(block, 'Undocumented') ?? '';
  const undocumented: string[] = [];
  for (const rawLine of undocumentedSection.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^\(none\)$/i.test(line)) continue;
    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    undocumented.push(bulletMatch ? bulletMatch[1]!.trim() : line);
  }

  return { summary, invariants, undocumented };
}

/**
 * Builds the verify prompt: the OLD doc body verbatim (the behavioral baseline the agent must compare
 * against, not rewrite), the CURRENT module source (same collectFiles/readExcerpt batching as generate,
 * capped at maxFilesPerPrompt — a full multi-batch merge across verify calls is a deliberate v1 scope
 * cut), and the response contract naming the old doc's actual invariant ids.
 */
export async function buildVerifyPrompt(
  module: ModuleDescriptor,
  config: ResolvedDocmapConfig,
  oldDoc: { frontmatter: ModuleFrontmatter; body: string },
  instructions?: string,
): Promise<string> {
  const allFiles = collectFiles(module.elements);
  const files = allFiles.slice(0, config.maxFilesPerPrompt);
  const omittedCount = allFiles.length - files.length;
  const excerpts = await Promise.all(
    files.map(async (f) => ({
      relPath: f.relPath,
      content: await readExcerpt(f.absPath, config.maxFileExcerptBytes),
    })),
  );
  const fileBlocks = excerpts.map((e) => `### ${e.relPath}\n\`\`\`\n${e.content}\n\`\`\``).join('\n\n');

  const invariants = oldDoc.frontmatter.invariants ?? [];
  const hasInvariants = invariants.length > 0;
  const invariantsList = hasInvariants
    ? invariants.map((inv) => `${inv.id}: ${inv.text}`).join('\n')
    : '(none documented)';

  const lines: string[] = [
    `You are verifying whether the "${module.name}" module (framework: ${module.framework}) still behaves the way its EXISTING documentation claims — you are checking for a regression, not writing new documentation.`,
    'The OLD DOCUMENTATION below is the behavioral baseline (in particular its Business Logic and Invariants sections) — it describes what the module was documented to do BEFORE the current source shown after it. Do not rewrite it; compare it against the current code.',
  ];

  if (instructions) {
    lines.push(
      '',
      'Project-specific documentation instructions (context/tone only — they do not change the verification contract below):',
      instructions,
    );
  }

  lines.push('', '=== OLD DOCUMENTATION (baseline) ===', oldDoc.body, '', '=== CURRENT SOURCE ===', fileBlocks || '(no files)');

  if (omittedCount > 0) {
    lines.push(
      '',
      `Note: this module has ${allFiles.length} source files; only the first ${files.length} are shown above (${omittedCount} omitted due to the per-prompt file limit). If you cannot verify an invariant with the excerpts shown, say so honestly in its justification rather than guessing.`,
    );
  }

  if (hasInvariants) {
    lines.push(
      '',
      'The old documentation declared exactly these invariants (use these exact ids in your response):',
      invariantsList,
    );
  } else {
    lines.push(
      '',
      'The old documentation had no "## Invariants" section (it predates this format, or the module genuinely documents no invariants). Report "## Invariants" as exactly "(none documented)" below, and focus your verdict on "## Undocumented" and an honest "## Summary".',
    );
  }

  const invariantContractLines = hasInvariants
    ? invariants
        .map((inv) => `${inv.id}: KEPT|CHANGED|VIOLATED — <short justification citing the current code>`)
        .join('\n')
    : '(none documented)';

  lines.push(
    '',
    'Output contract — respond with ONLY the following block, no other prose:',
    `${VERIFY_START}`,
    '## Summary',
    'COMPATIBLE|CHANGED|BREAKING  (write exactly one of these three words, nothing else on that line)',
    '',
    '## Invariants',
    invariantContractLines,
    '(one line per invariant id listed above, in the exact form "I<n>: VERDICT — justification")',
    '',
    '## Undocumented',
    '- <a new piece of behavior visible in the current source with no corresponding invariant or doc coverage>',
    '(or "(none)" if there is none)',
    `${VERIFY_END}`,
    '',
    'Ground every verdict and every undocumented-behavior bullet strictly in the current source shown above — never invent behavior that is not visible in the excerpts.',
  );

  return lines.join('\n');
}

export interface VerifyCallOutcome {
  parsed: ParsedVerifyOutput | null;
  lastResult: RunnerResult;
}

/**
 * Single verify call with the same retry-escalation shape as orchestrator.ts's runBatch: timeout
 * doubling on a likely timeout, a plain resend on a runner error, and a stricter-contract-reminder
 * resend when the agent replied without the required marker block(s).
 */
export async function runVerifyCall(
  module: ModuleDescriptor,
  oldDoc: { frontmatter: ModuleFrontmatter; body: string },
  projectRoot: string,
  config: ResolvedDocmapConfig,
  runner: AgentRunner,
  instructions?: string,
  logger?: Logger,
): Promise<VerifyCallOutcome> {
  const prompt = await buildVerifyPrompt(module, config, oldDoc, instructions);

  const call = async (p: string, timeoutMs: number) => {
    const result = await runner.run({
      prompt: p,
      cwd: projectRoot,
      moduleId: module.id,
      elementIds: [],
      timeoutMs,
      model: config.model,
    });
    return { result, parsed: parseVerifyOutput(result.text) };
  };

  let timeoutMs = config.timeoutMs;
  let { result, parsed } = await call(prompt, timeoutMs);

  let attempts = 0;
  while (parsed === null && attempts < config.maxRetries) {
    attempts += 1;
    if (isLikelyTimeout(result, timeoutMs)) {
      timeoutMs *= 2;
      logger?.info(
        `[retry] ${module.id} — verify attempt ${attempts + 1}/${config.maxRetries + 1} with timeout raised to ${Math.round(timeoutMs / 1000)}s`,
      );
      ({ result, parsed } = await call(prompt, timeoutMs));
    } else if (!result.ok) {
      logger?.info(
        `[retry] ${module.id} — verify attempt ${attempts + 1}/${config.maxRetries + 1} after a runner error: ${describeBatchFailure(result, timeoutMs)}`,
      );
      ({ result, parsed } = await call(prompt, timeoutMs));
    } else {
      const stricterPrompt = `${prompt}\n\nIMPORTANT: your previous response did not follow the required output contract (a ${VERIFY_START}...${VERIFY_END} block with a valid ## Summary value). Respond again, following the output contract exactly.`;
      logger?.info(
        `[retry] ${module.id} — verify attempt ${attempts + 1}/${config.maxRetries + 1} after a contract-format miss`,
      );
      ({ result, parsed } = await call(stricterPrompt, timeoutMs));
    }
  }

  return { parsed, lastResult: result };
}

export type VerifyModuleStatus = 'missing' | 'unchanged' | 'verified';

export interface VerifyModuleReport {
  moduleId: string;
  name: string;
  status: VerifyModuleStatus;
  verdict?: 'COMPATIBLE' | 'CHANGED' | 'BREAKING';
  invariants?: InvariantVerdict[];
  undocumented?: string[];
  error?: string;
}

export interface VerifyOptions {
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runnerName: RunnerName;
  moduleIds?: string[];
  /** Only used by the command layer to decide the exit code — runVerify itself just returns verdicts. */
  strict?: boolean;
}

export interface VerifySummary {
  frameworkName: string;
  reports: VerifyModuleReport[];
}

export async function runVerify(options: VerifyOptions): Promise<VerifySummary> {
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

  const instructions = config.skill ? await loadSkillInstructions(projectRoot, config.skill, logger) : undefined;

  const limit = createConcurrencyLimiter(config.concurrency);
  const reports: VerifyModuleReport[] = [];

  const progress = new ProgressTracker(logger, targetModules.length);
  logger.info(
    `[verify] ${targetModules.length} modules · runner=${runnerName} concurrency=${config.concurrency} timeout=${Math.round(config.timeoutMs / 1000)}s`,
  );
  progress.startHeartbeat();

  try {
    await Promise.all(
      targetModules.map((module) =>
        limit(async () => {
          try {
            const report = await verifyModule({ module, projectRoot, config, logger, runner, instructions, progress });
            reports.push(report);
          } catch (err) {
            reports.push({
              moduleId: module.id,
              name: module.name,
              status: 'verified',
              error: (err as Error).message,
            });
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

export async function verifyModule(args: {
  module: ModuleDescriptor;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runner: AgentRunner;
  instructions?: string;
  progress?: ProgressTracker;
}): Promise<VerifyModuleReport> {
  const { module, projectRoot, config, logger, runner, instructions, progress } = args;

  const oldDoc = await readModuleDoc(projectRoot, module);
  if (!oldDoc) {
    logger.info(`[skip] ${module.id} — no existing doc, nothing to verify`);
    return { moduleId: module.id, name: module.name, status: 'missing' };
  }

  const fingerprint = await computeModuleFingerprint(module);
  if (oldDoc.frontmatter.fingerprint === fingerprint) {
    logger.info(`[skip] ${module.id} — unchanged since last generate`);
    return { moduleId: module.id, name: module.name, status: 'unchanged' };
  }

  const label = module.id;
  logger.info(`[run] ${module.id} — verifying stale doc against current source`);
  progress?.batchStarted(label);
  const startedAt = Date.now();
  let outcome: VerifyCallOutcome;
  try {
    outcome = await runVerifyCall(module, oldDoc, projectRoot, config, runner, instructions, logger);
  } finally {
    progress?.batchFinished(label);
  }

  const { parsed, lastResult } = outcome;
  if (parsed === null) {
    // A parse failure must never be defaulted to COMPATIBLE — that would silently hide a real
    // problem. Surface it as an error the human must look at instead.
    const reason = describeBatchFailure(lastResult, config.timeoutMs);
    logger.warn(`[error] ${module.id} — verify did not return a valid response (${reason})`);
    return { moduleId: module.id, name: module.name, status: 'verified', error: reason };
  }

  logger.info(`[ok] ${module.id} — verify: ${parsed.summary} in ${formatDuration(Date.now() - startedAt)}`);
  return {
    moduleId: module.id,
    name: module.name,
    status: 'verified',
    verdict: parsed.summary as 'COMPATIBLE' | 'CHANGED' | 'BREAKING',
    invariants: parsed.invariants,
    undocumented: parsed.undocumented,
  };
}

function formatReportTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Writes a human-readable verify report to .docmap/.reports/verify-<yyyy-MM-dd-HHmm>.md: a summary
 * table for every module, plus a per-invariant detail section for any module that came back CHANGED or
 * BREAKING. The timestamp is derived from the `timestamp` argument (not Date.now()) so this stays
 * testable.
 */
export async function writeVerifyReport(
  projectRoot: string,
  reports: VerifyModuleReport[],
  timestamp: Date,
): Promise<string> {
  const dir = path.join(getDocmapRoot(projectRoot), '.reports');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `verify-${formatReportTimestamp(timestamp)}.md`);

  const lines: string[] = [
    '# docmap verify report',
    '',
    `Generated: ${timestamp.toISOString()}`,
    '',
    '| Module | Status | Verdict |',
    '| --- | --- | --- |',
  ];
  for (const r of reports) {
    const verdictCell = r.verdict ?? (r.error ? `error: ${r.error}` : '-');
    lines.push(`| ${r.name} (${r.moduleId}) | ${r.status} | ${verdictCell} |`);
  }

  const detailed = reports.filter(
    (r) => r.status === 'verified' && (r.verdict === 'CHANGED' || r.verdict === 'BREAKING'),
  );
  if (detailed.length > 0) {
    lines.push('', '## Details');
    for (const r of detailed) {
      lines.push('', `### ${r.name} (${r.moduleId}) — ${r.verdict}`);
      if (r.invariants && r.invariants.length > 0) {
        for (const inv of r.invariants) {
          lines.push(`- ${inv.id}: ${inv.verdict} — ${inv.note}`);
        }
      } else {
        lines.push('- (no invariants were documented for this module)');
      }
      if (r.undocumented && r.undocumented.length > 0) {
        lines.push('', 'Undocumented behavior:');
        for (const u of r.undocumented) lines.push(`- ${u}`);
      }
    }
  }

  const content = `${lines.join('\n')}\n`;
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}
