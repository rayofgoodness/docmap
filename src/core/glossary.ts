import type { ModuleDescriptor } from '../adapters/types.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';
import type { GlossaryFrontmatter } from '../docFormat/frontmatter.js';
import type { Logger } from '../utils/logger.js';
import { getSectionLabels, type SectionLabels } from '../utils/lang.js';
import { BODY_END, BODY_START, parseAgentOutput } from './markers.js';
import { readBriefDoc, writeGlossaryDoc } from './docWriter.js';
import { describeBatchFailure, isLikelyTimeout } from './orchestrator.js';
import type { AgentRunner, RunnerResult } from '../runners/types.js';

/**
 * A single glossary run reads every module's brief body and stuffs it into one prompt — with a large
 * project that would balloon fast. Cap each brief down to just its "What this module does" and "Key
 * scenarios" sections (the two that actually carry domain terms), and cap those excerpts themselves,
 * in the same spirit as promptBuilder.ts's readExcerpt truncation for source files.
 */
const MAX_EXCERPT_CHARS = 1500;

/** Splits a brief body into its `## <heading>` sections, keyed by the (already-localized) heading text. */
function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const newlineIdx = part.indexOf('\n');
    const heading = (newlineIdx === -1 ? part : part.slice(0, newlineIdx)).trim();
    const content = (newlineIdx === -1 ? '' : part.slice(newlineIdx + 1)).trim();
    sections[heading] = content;
  }
  return sections;
}

/**
 * Pulls just the "What this module does" and "Key scenarios" sections out of a brief body — the parts
 * that name domain concepts and user-facing flows, without the business-rules/QA-checklist bulk that
 * would otherwise dominate the glossary prompt for no benefit. Falls back to the whole body if a brief
 * doesn't use the expected headings (e.g. hand-edited), so a malformed brief still contributes something
 * rather than being silently dropped.
 */
export function buildGlossaryExcerpt(body: string, labels: SectionLabels): string {
  const sections = splitSections(body);
  const whatItDoes = sections[labels.briefWhatItDoes];
  const keyScenarios = sections[labels.briefKeyScenarios];

  const excerpt =
    whatItDoes || keyScenarios
      ? [
          whatItDoes ? `## ${labels.briefWhatItDoes}\n${whatItDoes}` : null,
          keyScenarios ? `## ${labels.briefKeyScenarios}\n${keyScenarios}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join('\n\n')
      : body;

  if (excerpt.length <= MAX_EXCERPT_CHARS) return excerpt;
  return `${excerpt.slice(0, MAX_EXCERPT_CHARS)}\n...[truncated]`;
}

export interface GlossaryBriefInput {
  module: ModuleDescriptor;
  excerpt: string;
}

/**
 * Structurally identical single-block contract to the generate command's module-overview block, so it
 * reuses markers.ts's BODY_START/BODY_END and parseAgentOutput rather than inventing a third marker
 * vocabulary (brief.ts's BRIEF_START/END is deliberately separate because it IS a third shape — this
 * one genuinely isn't).
 */
export function buildGlossaryPrompt(briefs: GlossaryBriefInput[], labels: SectionLabels, language: string): string {
  const moduleBlocks = briefs
    .map(({ module, excerpt }) => `### module-id: ${module.id}\n${excerpt}`)
    .join('\n\n');

  const lines: string[] = [
    `You are building a DOMAIN GLOSSARY for a software project, for a new manager or QA person who is not a developer and needs one entry point into "what does the system call things". Below are excerpts from ${briefs.length} module business brief(s) — each brief's "${labels.briefWhatItDoes}" and "${labels.briefKeyScenarios}" sections.`,
    `Write ALL prose in language code "${language}".`,
    '',
    'Module brief excerpts:',
    moduleBlocks,
    '',
    'Extract every distinct domain term used across these briefs — nouns that name a business concept a manager or tester would recognize (e.g. order, cart, promo code, shipping, refund), not a technical implementation detail (not "component", "store", "endpoint"). A term that appears in more than one brief\'s excerpt gets ONE glossary entry listing every module it lives in.',
    '',
    'Output contract — respond with ONLY the following block, no other prose. One bullet per term, sorted alphabetically:',
    BODY_START,
    '- **<term>** — <one-line plain-language definition> — lives in: `<module-id>`[, `<module-id>`...]',
    '- **<next term>** — ...',
    BODY_END,
  ];

  return lines.join('\n');
}

export interface GlossaryResult {
  written: boolean;
  reason?: string;
}

export interface BuildGlossaryOptions {
  projectRoot: string;
  /** Modules discovered in THIS run — buildGlossary reads whichever of these currently have a brief on
   * disk (readBriefDoc), regardless of whether this particular run (re)generated it. */
  modules: ModuleDescriptor[];
  config: ResolvedDocmapConfig;
  runner: AgentRunner;
  logger?: Logger;
}

/**
 * Runs once at the end of a full (non-`--module`-scoped) `docmap brief` run: aggregates every module's
 * currently-on-disk brief into one prompt and asks for a single glossary block. Intentionally takes
 * `runner`/`config` rather than re-resolving them, since runBrief already has a checked-available
 * runner in hand by the time it finishes the per-module pass.
 */
export async function buildGlossary(options: BuildGlossaryOptions): Promise<GlossaryResult> {
  const { projectRoot, modules, config, runner, logger } = options;
  const labels = getSectionLabels(config.language);

  const briefs: GlossaryBriefInput[] = [];
  for (const module of modules) {
    const brief = await readBriefDoc(projectRoot, module);
    if (!brief) continue;
    briefs.push({ module, excerpt: buildGlossaryExcerpt(brief.body, labels) });
  }

  if (briefs.length === 0) {
    logger?.info('[glossary] skip — no briefs on disk to build a glossary from');
    return { written: false, reason: 'no briefs available' };
  }

  const prompt = buildGlossaryPrompt(briefs, labels, config.language);

  const call = async (p: string, timeoutMs: number) => {
    const result = await runner.run({
      prompt: p,
      cwd: projectRoot,
      moduleId: 'glossary',
      elementIds: [],
      timeoutMs,
      model: config.model,
    });
    return { result, parsed: parseAgentOutput(result.text).body };
  };

  let timeoutMs = config.timeoutMs;
  let result: RunnerResult;
  let parsed: string | null;
  ({ result, parsed } = await call(prompt, timeoutMs));

  let attempts = 0;
  while (parsed === null && attempts < config.maxRetries) {
    attempts += 1;
    if (isLikelyTimeout(result, timeoutMs)) {
      timeoutMs *= 2;
      logger?.info(
        `[retry] glossary attempt ${attempts + 1}/${config.maxRetries + 1} with timeout raised to ${Math.round(timeoutMs / 1000)}s`,
      );
      ({ result, parsed } = await call(prompt, timeoutMs));
    } else if (!result.ok) {
      logger?.info(
        `[retry] glossary attempt ${attempts + 1}/${config.maxRetries + 1} after a runner error: ${describeBatchFailure(result, timeoutMs)}`,
      );
      ({ result, parsed } = await call(prompt, timeoutMs));
    } else {
      const stricterPrompt = `${prompt}\n\nIMPORTANT: your previous response did not follow the required output contract (a ${BODY_START}...${BODY_END} block). Respond again, following the output contract exactly.`;
      logger?.info(`[retry] glossary attempt ${attempts + 1}/${config.maxRetries + 1} after a contract-format miss`);
      ({ result, parsed } = await call(stricterPrompt, timeoutMs));
    }
  }

  if (parsed === null) {
    const reason = describeBatchFailure(result, timeoutMs);
    logger?.warn(`[error] glossary — did not return a valid response (${reason})`);
    return { written: false, reason };
  }

  const frontmatter: GlossaryFrontmatter = {
    docmap_version: 1,
    kind: 'glossary',
    language: config.language,
    generated_at: new Date().toISOString(),
    generated_by: { runner: runner.name, model: config.model },
  };

  await writeGlossaryDoc(projectRoot, frontmatter, parsed);
  logger?.info(`[ok] glossary — generated from ${briefs.length} brief(s)`);
  return { written: true };
}
