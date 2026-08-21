import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import type { RunnerName } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { getSectionLabels } from '../utils/lang.js';
import { loadSkillInstructions } from '../utils/skillInstructions.js';
import { discoverProject } from './discovery.js';
import { computeModuleFingerprint } from './fingerprint.js';
import { buildModulePrompt, splitIntoBatches, type PromptBatch } from './promptBuilder.js';
import { parseAgentOutput, type ParsedAgentOutput } from './markers.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { getRunner } from '../runners/registry.js';
import { buildModulePlaceholderBody } from '../docFormat/templates/moduleRoot.js';
import { buildElementPlaceholderBody } from '../docFormat/templates/element.js';
import { buildIndexBody } from '../docFormat/templates/index.js';
import {
  getDocmapRoot,
  readModuleDoc,
  writeElementDoc,
  writeIndexDoc,
  writeModuleDoc,
} from './docWriter.js';
import type { ElementFrontmatter, ModuleFrontmatter } from '../docFormat/frontmatter.js';
import type { AgentRunner, RunnerResult } from '../runners/types.js';

export type ModuleOutcome = 'generated' | 'skipped-up-to-date' | 'dry-run' | 'error';

export interface ModuleReport {
  moduleId: string;
  outcome: ModuleOutcome;
  detail?: string;
}

export interface GenerateOptions {
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runnerName: RunnerName;
  moduleIds?: string[];
  force?: boolean;
  dryRun?: boolean;
  failFast?: boolean;
}

export interface GenerateSummary {
  frameworkName: string;
  reports: ModuleReport[];
}

export async function runGenerate(options: GenerateOptions): Promise<GenerateSummary> {
  const { projectRoot, config, logger, runnerName, force = false, dryRun = false, failFast = false } = options;

  const ctx: DiscoveryContext = { projectRoot, config, logger };
  const { frameworkName, modules } = await discoverProject(ctx);
  const targetModules = options.moduleIds?.length
    ? modules.filter((m) => options.moduleIds!.includes(m.id))
    : modules;

  const runner = dryRun ? null : getRunner(runnerName);
  if (runner) {
    const availability = await runner.checkAvailable();
    if (!availability.available) {
      throw new Error(`Runner "${runnerName}" is unavailable: ${availability.reason}`);
    }
  }

  const instructions = config.skill ? await loadSkillInstructions(projectRoot, config.skill, logger) : undefined;

  const limit = createConcurrencyLimiter(config.concurrency);
  const reports: ModuleReport[] = [];
  let aborted = false;

  await Promise.all(
    targetModules.map((module) =>
      limit(async () => {
        if (aborted) return;
        try {
          const report = await processModule({
            module,
            projectRoot,
            config,
            logger,
            runner,
            runnerName,
            force,
            dryRun,
            instructions,
          });
          reports.push(report);
          if (report.outcome === 'error' && failFast) aborted = true;
        } catch (err) {
          reports.push({ moduleId: module.id, outcome: 'error', detail: (err as Error).message });
          if (failFast) aborted = true;
        }
      }),
    ),
  );

  if (!dryRun) {
    await writeIndex(projectRoot, modules, frameworkName);
  }

  return { frameworkName, reports };
}

export interface BatchOutcome {
  parsed: ParsedAgentOutput;
  lastResult: RunnerResult;
}

/** Turns a failed runner call into a one-line, actionable reason instead of a bare "no content" warning. */
export function describeBatchFailure(result: RunnerResult, timeoutMs: number): string {
  if (!result.ok) {
    const nearTimeout = result.durationMs >= timeoutMs * 0.95;
    const cause = nearTimeout
      ? `likely timed out (ran ${Math.round(result.durationMs / 1000)}s against a ${Math.round(timeoutMs / 1000)}s limit)`
      : `runner exited ${result.exitCode ?? 'with no code'}${result.error ? `: ${result.error}` : ''}`;
    return cause;
  }
  return 'agent responded but without the required marker block(s)';
}

async function runBatch(args: {
  module: ModuleDescriptor;
  batch: PromptBatch;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  runner: AgentRunner;
  instructions?: string;
}): Promise<BatchOutcome> {
  const { module, batch, projectRoot, config, runner, instructions } = args;
  const prompt = await buildModulePrompt(module, config, batch, instructions);
  const elementIds = batch.elements.map((e) => e.id);

  const call = async (p: string) => {
    const result = await runner.run({
      prompt: p,
      cwd: projectRoot,
      moduleId: module.id,
      elementIds,
      timeoutMs: config.timeoutMs,
      model: config.model,
    });
    return { result, parsed: parseAgentOutput(result.text) };
  };

  let { result, parsed } = await call(prompt);

  const failed = (p: ParsedAgentOutput) =>
    (batch.includeBody && p.body === null) || (batch.elements.length > 0 && Object.keys(p.elements).length === 0);

  let attempts = 0;
  while (failed(parsed) && attempts < config.maxRetries) {
    attempts += 1;
    const stricterPrompt = `${prompt}\n\nIMPORTANT: your previous response did not include the required marker block(s). Respond again, following the output contract exactly.`;
    ({ result, parsed } = await call(stricterPrompt));
  }

  return { parsed, lastResult: result };
}

async function processModule(args: {
  module: ModuleDescriptor;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runner: AgentRunner | null;
  runnerName: RunnerName;
  force: boolean;
  dryRun: boolean;
  instructions?: string;
}): Promise<ModuleReport> {
  const { module, projectRoot, config, logger, runner, runnerName, force, dryRun, instructions } = args;
  const fingerprint = await computeModuleFingerprint(module);

  if (!force) {
    const existing = await readModuleDoc(projectRoot, module);
    if (existing?.frontmatter.fingerprint === fingerprint && existing.frontmatter.language === config.language) {
      logger.info(`[skip] ${module.id} — up to date`);
      return { moduleId: module.id, outcome: 'skipped-up-to-date' };
    }
  }

  const batches = splitIntoBatches(module, config.maxFilesPerPrompt);

  if (dryRun) {
    for (const batch of batches) {
      const prompt = await buildModulePrompt(module, config, batch, instructions);
      await writePromptCache(projectRoot, module.id, prompt, batch);
    }
    logger.info(
      `[dry-run] ${module.id} — ${batches.length} prompt${batches.length > 1 ? 's' : ''} written` +
        (batches.length > 1 ? ` (${batches.length} batches)` : ''),
    );
    return { moduleId: module.id, outcome: 'dry-run' };
  }

  if (!runner) throw new Error('Runner unexpectedly unavailable outside dry-run');

  let moduleBody: string | null = null;
  const mergedElements: Record<string, string> = {};

  let bodyFailureReason: string | null = null;

  for (const batch of batches) {
    const { parsed, lastResult } = await runBatch({ module, batch, projectRoot, config, runner, instructions });
    if (batch.includeBody) {
      moduleBody = parsed.body;
      if (parsed.body === null) bodyFailureReason = describeBatchFailure(lastResult, config.timeoutMs);
    }
    Object.assign(mergedElements, parsed.elements);

    if (batches.length > 1 && batch.elements.length > 0 && Object.keys(parsed.elements).length === 0) {
      logger.warn(
        `[warn] ${module.id} — batch ${batch.batchIndex + 1}/${batch.totalBatches} returned no element content ` +
          `(${describeBatchFailure(lastResult, config.timeoutMs)}), those elements will get placeholder docs`,
      );
    }
  }

  if (moduleBody === null) {
    logger.warn(`[error] ${module.id} — agent did not return a valid body block (${bodyFailureReason ?? 'unknown reason'})`);
    return { moduleId: module.id, outcome: 'error', detail: bodyFailureReason ?? 'missing body marker' };
  }

  await writeModule({
    module,
    projectRoot,
    config,
    runnerName,
    fingerprint,
    parsed: { body: moduleBody, elements: mergedElements },
  });
  logger.info(`[ok] ${module.id} — generated${batches.length > 1 ? ` (${batches.length} batches)` : ''}`);
  return { moduleId: module.id, outcome: 'generated' };
}

async function writeModule(args: {
  module: ModuleDescriptor;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  runnerName: RunnerName;
  fingerprint: string;
  parsed: ParsedAgentOutput;
}): Promise<void> {
  const { module, projectRoot, config, runnerName, fingerprint, parsed } = args;
  const generatedAt = new Date().toISOString();
  const foldElements = module.elements.length <= config.elementDocThreshold;

  const moduleFrontmatter: ModuleFrontmatter = {
    docmap_version: 1,
    kind: 'module',
    id: module.id,
    name: module.name,
    framework: module.framework,
    path: module.relRootPath,
    status: 'implemented',
    language: config.language,
    fingerprint,
    generated_at: generatedAt,
    generated_by: { runner: runnerName, model: config.model },
    elements: foldElements ? [] : module.elements.map((e) => ({ id: e.id, path: `${e.id}.md` })),
    dependencies: module.relations
      .filter((r) => r.toModule)
      .map((r) => ({ module: r.toModule as string, type: r.type, detail: r.detail })),
    tags: [],
  };

  let body = parsed.body ?? buildModulePlaceholderBody(getSectionLabels(config.language));
  if (foldElements && module.elements.length > 0) {
    const foldedSections = module.elements
      .map((e) => `### ${e.name}\n${parsed.elements[e.id] ?? '_Pending generation._'}`)
      .join('\n\n');
    body = `${body}\n\n## Elements\n\n${foldedSections}`;
  }

  await writeModuleDoc(projectRoot, module, moduleFrontmatter, body);

  if (!foldElements) {
    for (const element of module.elements) {
      const elementFrontmatter: ElementFrontmatter = {
        docmap_version: 1,
        kind: 'element',
        id: element.id,
        module: module.id,
        elementKind: element.kind,
        name: element.name,
        status: 'implemented',
        language: config.language,
        files: element.files.map((f) => f.relPath),
        fingerprint: null,
        generated_at: generatedAt,
        relations: (element.relations ?? []).map((r) => ({
          type: r.type,
          to: r.toModule ?? r.toId,
          confidence: r.confidence,
          detail: r.detail,
        })),
      };
      const elementBody = parsed.elements[element.id] ?? buildElementPlaceholderBody(getSectionLabels(config.language));
      await writeElementDoc(projectRoot, module, element, elementFrontmatter, elementBody);
    }
  }
}

async function writeIndex(projectRoot: string, modules: ModuleDescriptor[], _frameworkName: string): Promise<void> {
  const generatedAt = new Date().toISOString();
  const statuses = await Promise.all(
    modules.map(async (m) => (await readModuleDoc(projectRoot, m))?.frontmatter.status ?? 'planned'),
  );

  await writeIndexDoc(
    projectRoot,
    {
      docmap_version: 1,
      kind: 'index',
      generated_at: generatedAt,
      modules: modules.map((m, i) => ({
        id: m.id,
        path: m.relRootPath,
        framework: m.framework,
        status: statuses[i] ?? 'planned',
      })),
    },
    buildIndexBody(modules),
  );
}

async function writePromptCache(projectRoot: string, moduleId: string, prompt: string, batch: PromptBatch): Promise<void> {
  const dir = path.join(getDocmapRoot(projectRoot), '.cache', 'prompts');
  await fs.mkdir(dir, { recursive: true });
  const filename = batch.totalBatches > 1 ? `${moduleId}.batch${batch.batchIndex}.txt` : `${moduleId}.txt`;
  await fs.writeFile(path.join(dir, filename), prompt, 'utf8');
}
