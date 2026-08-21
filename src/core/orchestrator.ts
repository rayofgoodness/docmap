import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import type { RunnerName } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { getSectionLabels } from '../utils/lang.js';
import { discoverProject } from './discovery.js';
import { computeModuleFingerprint } from './fingerprint.js';
import { buildModulePrompt } from './promptBuilder.js';
import { parseAgentOutput } from './markers.js';
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

  const limit = createConcurrencyLimiter(config.concurrency);
  const reports: ModuleReport[] = [];
  let aborted = false;

  await Promise.all(
    targetModules.map((module) =>
      limit(async () => {
        if (aborted) return;
        try {
          const report = await processModule({ module, projectRoot, config, logger, runner, runnerName, force, dryRun });
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

async function processModule(args: {
  module: ModuleDescriptor;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
  runner: ReturnType<typeof getRunner> | null;
  runnerName: RunnerName;
  force: boolean;
  dryRun: boolean;
}): Promise<ModuleReport> {
  const { module, projectRoot, config, logger, runner, runnerName, force, dryRun } = args;
  const fingerprint = await computeModuleFingerprint(module);

  if (!force) {
    const existing = await readModuleDoc(projectRoot, module);
    if (existing?.frontmatter.fingerprint === fingerprint && existing.frontmatter.language === config.language) {
      logger.info(`[skip] ${module.id} — up to date`);
      return { moduleId: module.id, outcome: 'skipped-up-to-date' };
    }
  }

  const prompt = await buildModulePrompt(module, config);

  if (dryRun) {
    await writePromptCache(projectRoot, module.id, prompt);
    logger.info(`[dry-run] ${module.id} — prompt written (~${Math.round(prompt.length / 4)} tokens est.)`);
    return { moduleId: module.id, outcome: 'dry-run' };
  }

  if (!runner) throw new Error('Runner unexpectedly unavailable outside dry-run');

  let parsed = parseAgentOutput(
    (await runner.run({
      prompt,
      cwd: projectRoot,
      moduleId: module.id,
      elementIds: module.elements.map((e) => e.id),
      timeoutMs: config.timeoutMs,
      model: config.model,
    })).text,
  );

  let attempts = 0;
  while (parsed.body === null && attempts < config.maxRetries) {
    attempts += 1;
    const stricterPrompt = `${prompt}\n\nIMPORTANT: your previous response did not include the required ${'<<<DOCMAP_BODY_START>>>'} marker block. Respond again, following the output contract exactly.`;
    parsed = parseAgentOutput(
      (await runner.run({
        prompt: stricterPrompt,
        cwd: projectRoot,
        moduleId: module.id,
        elementIds: module.elements.map((e) => e.id),
        timeoutMs: config.timeoutMs,
        model: config.model,
      })).text,
    );
  }

  if (parsed.body === null) {
    logger.warn(`[error] ${module.id} — agent did not return a valid body block`);
    return { moduleId: module.id, outcome: 'error', detail: 'missing body marker' };
  }

  await writeModule({ module, projectRoot, config, runnerName, fingerprint, parsed });
  logger.info(`[ok] ${module.id} — generated`);
  return { moduleId: module.id, outcome: 'generated' };
}

async function writeModule(args: {
  module: ModuleDescriptor;
  projectRoot: string;
  config: ResolvedDocmapConfig;
  runnerName: RunnerName;
  fingerprint: string;
  parsed: ReturnType<typeof parseAgentOutput>;
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

async function writePromptCache(projectRoot: string, moduleId: string, prompt: string): Promise<void> {
  const dir = path.join(getDocmapRoot(projectRoot), '.cache', 'prompts');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${moduleId}.txt`), prompt, 'utf8');
}
