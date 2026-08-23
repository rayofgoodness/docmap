import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import { ModuleFrontmatterSchema, type ModuleFrontmatter } from '../docFormat/frontmatter.js';
import { tryParseDoc } from '../docFormat/parse.js';
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

/** A `--since <ref>` diff scoped to the files of one module, ready to drop into the verify prompt. */
export interface SinceDiff {
  ref: string;
  /** Project-root-relative paths (posix) of this module's files touched by the diff. */
  files: string[];
  /** Unified diff text, already truncated to the per-excerpt byte budget. */
  diffText: string;
}

/** Truncates a unified diff to the same per-excerpt byte budget as source excerpts (readExcerpt's
 * convention in promptBuilder.ts), so a widely-touched module's `--since` diff can't blow the prompt
 * budget the way an untruncated diff could. */
function truncateDiffText(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  return `${diff.slice(0, maxBytes)}\n...[diff truncated]`;
}

/** Project-root-relative (posix) path of a module file — module.files' own relPath is relative to the
 * module's rootPath, not the project root, so it must be re-anchored under relRootPath before it can be
 * compared against `git diff --name-only`'s project-root-relative output. */
function moduleFileProjectRelPath(module: ModuleDescriptor, relPath: string): string {
  return module.relRootPath ? `${module.relRootPath}/${relPath}` : relPath;
}

/**
 * Resolves the `--since <ref>` diff for one module: intersects the project-wide changed-file list
 * (computed once per `runVerify` call, not per module) against this module's own files, and — only when
 * that intersection is non-empty — fetches a unified diff scoped to just those files. Returns undefined
 * when `--since` isn't in play, the module's files weren't touched, or the per-module `git diff` call
 * itself fails (logged as a warning; the module still gets verified in full-module mode either way).
 */
export async function resolveSinceDiffForModule(
  module: ModuleDescriptor,
  projectRoot: string,
  config: ResolvedDocmapConfig,
  since: { ref: string; changedFiles: string[] },
  logger?: Logger,
): Promise<SinceDiff | undefined> {
  const changed = new Set(since.changedFiles);
  const touchedFiles = module.files
    .map((f) => moduleFileProjectRelPath(module, f.relPath))
    .filter((relPath) => changed.has(relPath));
  if (touchedFiles.length === 0) return undefined;

  try {
    const result = await execa('git', ['diff', since.ref, '--', ...touchedFiles], { cwd: projectRoot });
    return {
      ref: since.ref,
      files: touchedFiles,
      diffText: truncateDiffText(result.stdout, config.maxFileExcerptBytes),
    };
  } catch (err) {
    logger?.warn(`${module.id} — could not compute --since diff for its changed files (${(err as Error).message}), continuing without it`);
    return undefined;
  }
}

/**
 * Builds the verify prompt: the OLD doc body verbatim (the behavioral baseline the agent must compare
 * against, not rewrite), the CURRENT module source (same collectFiles/readExcerpt batching as generate,
 * capped at maxFilesPerPrompt — a full multi-batch merge across verify calls is a deliberate v1 scope
 * cut), and the response contract naming the old doc's actual invariant ids. When `sinceDiff` is set,
 * the unified diff is included ALONGSIDE (not instead of) the full current-source excerpts, to focus
 * the agent's attention on what changed without hiding the rest of the module.
 */
export async function buildVerifyPrompt(
  module: ModuleDescriptor,
  config: ResolvedDocmapConfig,
  oldDoc: { frontmatter: ModuleFrontmatter; body: string },
  instructions?: string,
  sinceDiff?: SinceDiff,
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

  if (sinceDiff) {
    lines.push(
      '',
      `The following file(s) changed since ${sinceDiff.ref} — pay particular attention to this diff when judging each invariant:`,
      '```diff',
      sinceDiff.diffText,
      '```',
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
  sinceDiff?: SinceDiff,
): Promise<VerifyCallOutcome> {
  const prompt = await buildVerifyPrompt(module, config, oldDoc, instructions, sinceDiff);

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
  /** Focuses each stale module's prompt on the unified diff against this git ref, alongside (not instead
   * of) the full current-source excerpts. When git itself is unavailable or projectRoot isn't a git repo,
   * this is silently downgraded to full-module verification (a warning is logged, nothing throws). */
  sinceRef?: string;
  /** Compares against a specific historical doc version instead of the current on-disk doc — e.g. a
   * `.docmap/.history/<module>/<generated_at>.md` snapshot. When set, every target module is verified
   * against this SAME baseline (the "unchanged since last generate" shortcut is skipped, since a
   * user-requested baseline must always be checked). Resolution failure throws rather than silently
   * falling back to the current doc. */
  against?: string;
}

/**
 * Resolves the `--against <path>` baseline for verify: a specific historical doc (typically under
 * `.docmap/.history/<module>/<generated_at>.md`) to compare against instead of the current on-disk doc.
 * - A path starting with `.history/` (or `./.history/`) is resolved under `.docmap/`.
 * - Any other path is treated as absolute, or relative to `projectRoot`, and read as-is.
 * Throws a clear, path-naming error on a missing or unparsable file — the user asked for a specific
 * baseline, so silently falling back to the current doc would be misleading.
 */
export async function resolveAgainstDoc(
  projectRoot: string,
  against: string,
): Promise<{ frontmatter: ModuleFrontmatter; body: string }> {
  const resolvedPath =
    against.startsWith('.history/') || against.startsWith('./.history/')
      ? path.join(getDocmapRoot(projectRoot), against)
      : path.isAbsolute(against)
        ? against
        : path.resolve(projectRoot, against);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch {
    throw new Error(`--against baseline not found: "${resolvedPath}"`);
  }

  const parsed = tryParseDoc(ModuleFrontmatterSchema, raw);
  if (!parsed) {
    throw new Error(`--against baseline at "${resolvedPath}" could not be parsed as a module doc`);
  }
  return parsed;
}

/** Project-wide `--since` context resolved once per `runVerify` call and handed to every module, so a
 * missing/broken git only produces one warning instead of one per module. */
export interface SinceContext {
  ref: string;
  /** Project-root-relative (posix) paths touched since `ref`, per `git diff --name-only`. */
  changedFiles: string[];
}

/**
 * Runs `git diff --name-only <ref>` scoped to projectRoot. Returns null (after logging a warning) when
 * git is unavailable or projectRoot isn't a git repository at all — the caller must fall back to
 * full-module verification exactly as if `--since` had not been passed, never throw and never skip a
 * module over this.
 */
export async function resolveSinceContext(
  ref: string,
  projectRoot: string,
  logger?: Logger,
): Promise<SinceContext | null> {
  try {
    const result = await execa('git', ['diff', '--name-only', ref], { cwd: projectRoot });
    const changedFiles = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { ref, changedFiles };
  } catch (err) {
    logger?.warn(`--since ignored: ${(err as Error).message}, falling back to full-module verification`);
    return null;
  }
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

  const since = options.sinceRef ? await resolveSinceContext(options.sinceRef, projectRoot, logger) : null;
  const against = options.against ? await resolveAgainstDoc(projectRoot, options.against) : undefined;

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
            const report = await verifyModule({
              module,
              projectRoot,
              config,
              logger,
              runner,
              instructions,
              progress,
              since: since ?? undefined,
              against,
            });
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
  since?: SinceContext;
  /** A specific historical doc to use as the baseline instead of the current on-disk doc (from
   * `--against`). When set, the "unchanged since last generate" shortcut is skipped — a user-requested
   * baseline must always be checked against current source, regardless of the current doc's fingerprint. */
  against?: { frontmatter: ModuleFrontmatter; body: string };
}): Promise<VerifyModuleReport> {
  const { module, projectRoot, config, logger, runner, instructions, progress, since, against } = args;

  const oldDoc = against ?? (await readModuleDoc(projectRoot, module));
  if (!oldDoc) {
    logger.info(`[skip] ${module.id} — no existing doc, nothing to verify`);
    return { moduleId: module.id, name: module.name, status: 'missing' };
  }

  const fingerprint = await computeModuleFingerprint(module);
  if (!against && oldDoc.frontmatter.fingerprint === fingerprint) {
    // KNOWN LIMITATION (v1): with --since, a module whose fingerprint already matches its doc is still
    // treated as unchanged even if --since's diff touched it — the doc may already have silently adopted
    // a regression as its new baseline (generate ran again after the change before verify ever caught
    // it). Re-verifying against an older baseline is out of scope for v1; see README's
    // "Business-logic regression guard" section.
    logger.info(`[skip] ${module.id} — unchanged since last generate`);
    return { moduleId: module.id, name: module.name, status: 'unchanged' };
  }

  const sinceDiff = since ? await resolveSinceDiffForModule(module, projectRoot, config, since, logger) : undefined;

  const label = module.id;
  logger.info(`[run] ${module.id} — verifying stale doc against current source`);
  progress?.batchStarted(label);
  const startedAt = Date.now();
  let outcome: VerifyCallOutcome;
  try {
    outcome = await runVerifyCall(module, oldDoc, projectRoot, config, runner, instructions, logger, sinceDiff);
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
